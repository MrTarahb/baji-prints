require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Resend is optional — only initialise if API key is set
let resend = null;
if (process.env.RESEND_API_KEY) {
  const { Resend } = require('resend');
  resend = new Resend(process.env.RESEND_API_KEY);
}

// Stripe is optional — only initialise if secret key is set
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// Delivery method display labels (prices now live in the shipping_rates table, editable from admin)
const DELIVERY_LABELS = {
  ch:       'Standard shipping (Switzerland / Liechtenstein)',
  personal: 'Personal delivery (Switzerland / Liechtenstein)',
  intl:     'International shipping',
};

// Where customer replies to order emails should actually land — noreply@ can't
// receive mail, so we set this as the reply-to header instead.
const REPLY_TO_EMAIL = process.env.REPLY_TO_EMAIL || 'bhartu.bhatia@gmail.com';

// Client proofing-board reactions go to the business inbox, deliberately NOT to
// EMAIL_TO — that one is the personal address order notifications land in.
const CLIENT_NOTIFY_EMAIL = process.env.CLIENT_NOTIFY_EMAIL || 'support@bharatbhatia.photography';

// EU country codes (CH and LI handled separately as domestic)
const EU_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU',
  'IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES',
  'SE','GB','IS','LI','NO' // LI = Liechtenstein treated as CH but listed for completeness
]);

// Load all shipping settings into a key-value map
async function getShippingSettings() {
  try {
    const { rows } = await pool.query('SELECT key, value FROM shipping_settings');
    const s = {
      // Hardcoded fallbacks in case table is empty or not yet seeded
      tube_weight_a3_g: 100,
      tube_weight_a2_g: 200,
      envelope_weight_a4_g: 50,
      prints_per_tube: 3,
      ch_letter_price: 200,
      ch_packet_price: 900,
    };
    rows.forEach(r => { const v = parseInt(r.value); if (!isNaN(v)) s[r.key] = v; });
    return s;
  } catch (e) {
    // Table may not exist yet on first boot
    return { tube_weight_a3_g: 100, tube_weight_a2_g: 200, envelope_weight_a4_g: 50, prints_per_tube: 3, ch_letter_price: 200, ch_packet_price: 900 };
  }
}

// Calculate total shipment weight in grams given cart items and their paper weights
async function calcShipmentWeight(items) {
  // items: [{size, paper_weight_gsm, print_id}]
  // Returns { weight_g, format: 'letter'|'packet', tubes_needed }
  const s = await getShippingSettings();

  // Separate A4 (letter) from A3/A2 (packet/tube)
  const a4Items = items.filter(i => i.size === 'A4');
  const tubeItems = items.filter(i => i.size === 'A3' || i.size === 'A2');

  let totalWeight = 0;
  let format = 'letter';
  let a2Tubes = 0;
  let a3Tubes = 0;

  // A4: flat envelope + paper weight per sheet
  for (const item of a4Items) {
    const paperWeightG = (item.paper_weight_gsm || 200) * 0.0625;
    totalWeight += paperWeightG;
  }
  if (a4Items.length) totalWeight += s.envelope_weight_a4_g || 50;

  // A3/A2 tube items
  if (tubeItems.length) {
    format = 'packet';
    const printsPerTube = s.prints_per_tube || 3;
    const a2s = tubeItems.filter(i => i.size === 'A2');
    const a3s = tubeItems.filter(i => i.size === 'A3');

    a2Tubes = Math.ceil(a2s.length / printsPerTube);
    const remainingInLastA2Tube = a2Tubes > 0 ? (a2Tubes * printsPerTube - a2s.length) : 0;
    const a3sInA2Tube = Math.min(remainingInLastA2Tube, a3s.length);
    const a3sNeedingOwnTube = a3s.length - a3sInA2Tube;
    a3Tubes = Math.ceil(a3sNeedingOwnTube / printsPerTube);

    for (const item of tubeItems) {
      const area = item.size === 'A2' ? 0.25 : 0.125;
      const paperWeightG = (item.paper_weight_gsm || 200) * area;
      totalWeight += paperWeightG;
    }

    totalWeight += a2Tubes * (s.tube_weight_a2_g || 200);
    totalWeight += a3Tubes * (s.tube_weight_a3_g || 100);
  }

  if (a4Items.length && tubeItems.length) format = 'packet';

  return {
    weight_g: Math.ceil(totalWeight),
    format,
    tubes_needed: a2Tubes + a3Tubes,
    a2_tubes: a2Tubes,
    a3_tubes: a3Tubes,
  };
}

// Calculate shipping price for a given delivery method and country
// Returns { price_chf_cents, label, requires_quote }
async function calculateShipping(items, delivery_method, country_code, zone) {
  const s = await getShippingSettings();
  const { weight_g, format } = await calcShipmentWeight(items);
  const isChLi = !country_code || country_code === 'CH' || country_code === 'LI';
  const isEu = EU_COUNTRIES.has(country_code);

  if (delivery_method === 'personal') {
    if (!isChLi) return { price_chf_cents: 0, requires_quote: true, label: 'Contact for quote' };
    if (zone) {
      const { rows } = await pool.query(
        `SELECT price_chf_cents, label FROM personal_delivery_rates WHERE zone=$1`, [zone]
      );
      if (rows[0]) return { price_chf_cents: rows[0].price_chf_cents, requires_quote: false, label: rows[0].label };
    }
    // Default to cheapest zone if none specified
    const { rows } = await pool.query(
      `SELECT price_chf_cents, label FROM personal_delivery_rates ORDER BY price_chf_cents ASC LIMIT 1`
    );
    const basePrice = rows[0] ? rows[0].price_chf_cents : 4000;
    return { price_chf_cents: basePrice, requires_quote: false };
  }

  if (delivery_method === 'ch') {
    // Switzerland/Liechtenstein flat rates
    const price = format === 'packet' ? (s.ch_packet_price || 900) : (s.ch_letter_price || 200);
    return { price_chf_cents: price, requires_quote: false };
  }

  if (delivery_method === 'intl') {
    if (isChLi) {
      // Shouldn't happen but handle gracefully
      const price = format === 'packet' ? (s.ch_packet_price || 900) : (s.ch_letter_price || 200);
      return { price_chf_cents: price, requires_quote: false };
    }
    if (isEu) {
      // Look up EU bracket by format and weight
      const { rows } = await pool.query(
        `SELECT price_chf_cents FROM eu_shipping_rates
         WHERE format = $1 AND max_weight_g >= $2
         ORDER BY max_weight_g ASC LIMIT 1`,
        [format, weight_g]
      );
      if (rows[0]) return { price_chf_cents: rows[0].price_chf_cents, requires_quote: false };
      // Over max weight → quote
      return { price_chf_cents: 0, requires_quote: true, label: 'Shipment too heavy — contact for quote' };
    }
    // Rest of world → quote
    return { price_chf_cents: 0, requires_quote: true, label: 'Contact for shipping quote' };
  }

  return { price_chf_cents: 0, requires_quote: false };
}

// Size rank — used to pick the "largest" size in a cart for shipping calculation
const SIZE_RANK = { A4: 1, A3: 2, A2: 3 };

// Generates a short, human-readable order reference like "BHT-7K2X9P" —
// easy to read aloud, write on a package, or search for in admin. Avoids
// visually ambiguous characters (0/O, 1/I/L) to reduce transcription errors.
function generateOrderRef() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `BHT-${code}`;
}

// Same idea for workshop bookings — distinct prefix so an email subject or a
// search in admin makes immediately clear which kind of purchase it is.
function generateWorkshopRef() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `WSH-${code}`;
}

// Basic HTML escaping for any user/customer-supplied text dropped into email
// templates (e.g. shipping address fields), so stray characters can't break
// the markup or inject anything unexpected.
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Shared wrapper for all transactional emails — soft background, white card,
// consistent header/footer, so every email (admin notification, customer
// confirmation, shipped notice) looks like it belongs to the same site.
function emailShell(innerHtml) {
  return `
  <body style="margin:0;padding:0;background:#F2EFE8;font-family:Georgia,serif">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F2EFE8;padding:32px 16px">
      <tr><td align="center">
        <table width="100%" style="max-width:520px;background:#FFFFFF;border-radius:6px;overflow:hidden;border:1px solid #EFEFEC">
          <tr><td style="padding:24px 28px;border-bottom:1px solid #EFEFEC">
            <span style="font-family:Georgia,serif;font-style:italic;font-size:16px;color:#1A1714">Bharat Bhatia</span>
          </td></tr>
          <tr><td style="padding:28px">
            ${innerHtml}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>`;
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'baji-prints', allowed_formats: ['jpg', 'jpeg', 'png', 'webp'] },
});

// Separate folder for workshop gallery photos so they never mix with the
// portfolio/shop images in Cloudinary's media library.
const workshopStorage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'baji-workshops', allowed_formats: ['jpg', 'jpeg', 'png', 'webp'] },
});
const workshopUpload = multer({ storage: workshopStorage });
const upload = multer({ storage });

// Client proofing photos get their own per-client Cloudinary folder so a
// client's images never mix with the portfolio. The folder is resolved per
// request from req.uploadClientSlug, which the route sets before multer runs.
const clientStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req) => ({
    folder: `baji-clients/${req.uploadClientSlug || 'misc'}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
  }),
});
const clientUpload = multer({ storage: clientStorage });

app.use(cors());

// Stripe webhook needs the RAW body for signature verification —
// this route is registered BEFORE express.json() so the body stays unparsed
// Cloudinary transform helper — injects width/format/quality params into an
// upload URL at render time. Originals stay untouched in Cloudinary; this just
// asks their CDN for an appropriately-sized derivative (f_auto = WebP/AVIF for
// supporting clients, q_auto = automatic quality).
function cldUrl(url, width) {
  if (!url || !url.includes('/image/upload/') || url.includes('/upload/w_')) return url;
  return url.replace('/image/upload/', `/image/upload/w_${width},f_auto,q_auto/`);
}

// Sends the admin notification + customer confirmation for a paid order.
// Shared by the Stripe webhook and the manual admin "Sync" route, so that
// whichever path claims the pending→paid transition also triggers the emails —
// the losing path skips both (idempotency guard sits upstream of this call).
async function sendOrderConfirmationEmails(stripeSessionId) {
  if (!resend) return;
  const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE stripe_session_id=$1', [stripeSessionId]);
  const order = orderRows[0];
  if (!order) return;

  const { rows: items } = await pool.query(
    `SELECT oi.print_id, oi.size, oi.print_title, p.image_url
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN prints p ON p.id = oi.print_id
     WHERE o.stripe_session_id = $1`,
    [stripeSessionId]
  );

  const adminItemsHtml = items.map(i => `
    <tr>
      <td style="padding:8px 0;width:64px"><table cellpadding="0" cellspacing="0" style="width:60px;height:60px"><tr><td align="center" valign="middle">${i.image_url ? `<img src="${cldUrl(i.image_url, 200)}" alt="" style="max-width:60px;max-height:60px;border-radius:4px;display:block">` : ''}</td></tr></table></td>
      <td style="padding:8px 0 8px 12px;font-size:14px;color:#1A1714">${i.print_title || ('Print #' + i.print_id)}<span style="color:#8A8680">, ${i.size}</span></td>
    </tr>
  `).join('');

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'noreply@bharatbhatia.photography',
      to: process.env.EMAIL_TO || 'bhartu.bhatia@gmail.com',
      subject: `New order ${order.order_ref || ''}: CHF ${(order.total_chf/100).toFixed(2)}`,
      html: emailShell(`
        <h2 style="font-family:Georgia,serif;font-size:20px;margin:0 0 6px;color:#1A1714">New print order</h2>
        ${order.order_ref ? `<p style="font-family:monospace;font-size:12px;color:#8A8680;margin:0 0 18px">${order.order_ref}</p>` : ''}
        <p style="margin:0 0 6px;font-size:14px;color:#1A1714"><strong>Customer:</strong> ${order.customer_name || 'Unknown'} (${order.customer_email || 'no email on file'})</p>
        <p style="margin:0 0 6px;font-size:14px;color:#1A1714"><strong>Total:</strong> CHF ${(order.total_chf/100).toFixed(2)}</p>
        <p style="margin:0 0 18px;font-size:14px;color:#1A1714"><strong>Delivery:</strong> ${DELIVERY_LABELS[order.delivery_method] || order.delivery_method}</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px">${adminItemsHtml}</table>
        <p style="font-size:13px;color:#8A8680;margin:0">View full order details, the fulfilment checklist, and the customer's shipping address in the admin panel.</p>
      `)
    });
  } catch (e) { console.error('Order email failed:', e); }

  // Customer-facing confirmation — separate from Stripe's own invoice email,
  // this one carries your own voice and shows the actual prints they bought.
  if (order.customer_email) {
    const customerItemsHtml = items.map(i => `
      <tr>
        <td style="padding:10px 0;width:68px"><table cellpadding="0" cellspacing="0" style="width:64px;height:64px"><tr><td align="center" valign="middle">${i.image_url ? `<img src="${cldUrl(i.image_url, 200)}" alt="" style="max-width:64px;max-height:64px;border-radius:4px;display:block">` : ''}</td></tr></table></td>
        <td style="padding:10px 0 10px 14px;font-size:14px;color:#1A1714">${i.print_title || ''}<span style="color:#8A8680">, ${i.size}</span></td>
      </tr>
    `).join('');

    // Format the shipping address (if one was collected) so the customer
    // can verify it's correct and flag anything wrong before it ships.
    let addressHtml = '';
    if (order.shipping_address) {
      try {
        const addr = typeof order.shipping_address === 'string' ? JSON.parse(order.shipping_address) : order.shipping_address;
        const lines = [addr.line1, addr.line2, [addr.postal_code, addr.city].filter(Boolean).join(' '), addr.state, addr.country].filter(Boolean);
        if (lines.length) {
          addressHtml = `
            <p style="margin:0 0 4px;font-size:13px;color:#8A8680"><strong style="color:#1A1714">Shipping to:</strong></p>
            <p style="margin:0 0 22px;font-size:13px;color:#8A8680;line-height:1.6">${lines.map(l => esc(l)).join('<br>')}</p>
          `;
        }
      } catch (e) { /* malformed address, just skip showing it */ }
    }

    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'noreply@bharatbhatia.photography',
        to: order.customer_email,
        reply_to: REPLY_TO_EMAIL,
        subject: `Your order ${order.order_ref || ''}: Bharat Bhatia`,
        html: emailShell(`
          <h2 style="font-family:Georgia,serif;font-style:italic;font-size:22px;margin:0 0 8px;color:#1A1714">Thank you${order.customer_name ? ', ' + order.customer_name.split(' ')[0] : ''}.</h2>
          ${order.order_ref ? `<p style="font-family:monospace;font-size:12px;color:#8A8680;margin:0 0 18px">Order reference: ${order.order_ref}</p>` : ''}
          <p style="font-size:14px;color:#3D3731;line-height:1.7;margin:0 0 22px">Your order has been received and payment confirmed. I'll print, package, and get it on its way. You'll get another note from me once it ships.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border-top:1px solid #EFEFEC;border-bottom:1px solid #EFEFEC">${customerItemsHtml}</table>
          <p style="margin:0 0 6px;font-size:13px;color:#8A8680"><strong style="color:#1A1714">Delivery:</strong> ${DELIVERY_LABELS[order.delivery_method] || order.delivery_method}</p>
          ${addressHtml}
          <p style="margin:0 0 22px;font-size:13px;color:#8A8680"><strong style="color:#1A1714">Total paid:</strong> CHF ${(order.total_chf/100).toFixed(2)}</p>
          <p style="font-size:13px;color:#8A8680;line-height:1.7;margin:0">A formal receipt has been sent separately by Stripe. Please check the details above, especially the shipping address, and email ${REPLY_TO_EMAIL} right away if anything needs correcting. Mention your order reference if you can.</p>
        `), customerEmail: true
      });
    } catch (e) { console.error('Customer confirmation email failed:', e); }
  }
}

// Support both /api/stripe-webhook (Stripe Workbench default) and /api/stripe/webhook
const stripeWebhookHandler = async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Stripe not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      // Idempotency guard — Stripe retries webhook deliveries, and without this
      // check a retry would double-increment edition counters and send duplicate
      // emails. The atomic UPDATE ... WHERE status='pending' RETURNING means only
      // ONE delivery can ever claim the pending→paid transition; any duplicate
      // (retry, concurrent delivery, manual resend) sees zero rows and exits.
      const { rows: claimed } = await pool.query(
        `UPDATE orders SET status='paid', stripe_payment_intent=$1, updated_at=NOW()
         WHERE stripe_session_id=$2 AND status='pending'
         RETURNING id`,
        [session.payment_intent, session.id]
      );
      if (!claimed.length) {
        // Already processed, or unknown session — acknowledge with 200 so
        // Stripe stops retrying, but do no further work.
        console.log(`[webhook] duplicate/already-processed event for session ${session.id} — skipping`);
        return res.json({ received: true, duplicate: true });
      }

      // Populate customer details from the Stripe session — must happen before
      // we read the order back, otherwise the admin notification email shows
      // "null (null)" for the customer.
      try {
        // customer_details and shipping_details are already present on a
        // retrieved Checkout Session by default — no expand needed, and
        // 'customer_details' isn't a valid expandable field (passing it
        // throws, which was silently swallowing this whole block before).
        const fullSession = await stripe.checkout.sessions.retrieve(session.id);
        if (fullSession.customer_details) {
          // shipping_details is { name, phone, carrier, address: {...} } —
          // the actual postal fields are nested one level under .address.
          // Storing shipping_details directly (as before) put everything one
          // level too deep, which is why the admin UI's addr.line1 / addr.city
          // lookups were always coming back empty even though Stripe was
          // sending the address correctly the whole time.
          const addressToStore =
            (fullSession.shipping_details && fullSession.shipping_details.address) ||
            fullSession.customer_details.address || {};
          await pool.query(
            `UPDATE orders SET customer_name=$1, customer_email=$2, shipping_address=$3 WHERE stripe_session_id=$4`,
            [
              fullSession.customer_details.name,
              fullSession.customer_details.email,
              JSON.stringify(addressToStore),
              session.id,
            ]
          );
        }
      } catch (e) { console.error('Could not fetch customer details for webhook email:', e.message); }

      // Increment edition_sold counts for limited editions
      const { rows: items } = await pool.query(
        `SELECT oi.print_id, oi.size
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.stripe_session_id = $1`,
        [session.id]
      );
      for (const item of items) {
        await pool.query(
          `UPDATE print_sizes SET edition_sold = edition_sold + 1 WHERE print_id=$1 AND size=$2`,
          [item.print_id, item.size]
        );
      }

      // Admin notification + customer confirmation (shared with the sync route)
      await sendOrderConfirmationEmails(session.id);
    } catch (e) {
      console.error('Error processing webhook:', e);
    }
  }

  res.json({ received: true });
};

// Register both URL patterns — Stripe Workbench uses dash, legacy uses slash
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// Everything else gets normal JSON parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Public endpoint to calculate shipping before checkout
// Must be after express.json() so req.body is parsed
app.post('/api/shipping/calculate', async (req, res) => {
  try {
    const { items, delivery_method, country_code, zone } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });

    const enrichedItems = await Promise.all(items.map(async item => {
      const { rows } = await pool.query(
        `SELECT ps.size, pa.weight_gsm as paper_weight_gsm
         FROM print_sizes ps
         JOIN prints p ON p.id = ps.print_id
         LEFT JOIN papers pa ON pa.id = p.paper_id
         WHERE ps.print_id = $1 AND ps.size = $2`,
        [item.print_id, item.size]
      );
      return { ...item, paper_weight_gsm: rows[0]?.paper_weight_gsm || 200, size: item.size };
    }));

    const result = await calculateShipping(enrichedItems, delivery_method, country_code, zone);
    const { weight_g, format } = await calcShipmentWeight(enrichedItems);
    console.log(`[shipping] method=${delivery_method} zone=${zone||'-'} country=${country_code} weight=${weight_g}g format=${format} price=${result.price_chf_cents} quote=${result.requires_quote}`);
    res.json({ ...result, weight_g, format });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.use(express.static(path.join(__dirname, 'public'), {
  // Don't let static serve index.html automatically for '/' — our own '/'
  // route injects per-page SEO meta into it. Static still serves real assets.
  index: false,
  setHeaders: (res, filePath) => {
    // index.html (and the admin's index.html) is the entry point and changes
    // often — never let the browser cache a stale copy of it. Other static
    // assets (if any are added later) can still cache normally.
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.set('trust proxy', 1);
// Refuse to boot without a real session secret — a hardcoded fallback would
// mean anyone reading the source could forge admin session cookies.
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set');
  process.exit(1);
}
app.use(session({
  // Postgres-backed sessions (replaces the default MemoryStore, which leaks
  // memory and wipes all sessions on every deploy — i.e. admin logout each
  // time Railway restarts the container). Reuses the existing pg pool; the
  // "session" table is created automatically on first boot, and expired rows
  // are pruned in the background by connect-pg-simple.
  store: new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: 'none',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));


// Admin-only diagnostic: reports whether the Cloudinary env vars are set
// (never their values). Gated behind requireAuth so it isn't publicly reachable.
app.get('/api/debug/cloudinary', requireAuth, (req, res) => {
  res.json({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME ? 'set' : 'MISSING',
    api_key: process.env.CLOUDINARY_API_KEY ? 'set' : 'MISSING',
    api_secret: process.env.CLOUDINARY_API_SECRET ? 'set' : 'MISSING',
  });
});

// ── DB INIT ──────────────────────────────────────────────────────────────────
async function initDB() {
  // Step 1: create tables (pure SQL, no JS inside)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS prints (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      image_url TEXT NOT NULL,
      public_id TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      exclude_from_hero BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Add column if upgrading existing DB
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS exclude_from_hero BOOLEAN DEFAULT FALSE;
    -- Separate flag: excludes a print from being picked as a CATEGORY hero
    -- specifically, without affecting its eligibility for the main-page hero.
    -- Some photos read fine in the feed but don't work well blown up full-bleed
    -- as a category hero, hence the separate control.
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS exclude_from_category_hero BOOLEAN DEFAULT FALSE;
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'abstract';
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS categories JSONB DEFAULT '["abstract-bnw"]'::jsonb;

    -- ── CATEGORIES: admin-editable list backing both the public nav filter
    -- and the per-print tagging checkboxes. Replaces what used to be a
    -- hardcoded array duplicated in both public/index.html and admin/index.html.
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- CREATE TABLE IF NOT EXISTS is a no-op when the table already exists, so
    -- a column added to the CREATE above never reaches a live DB that already
    -- has the table. This explicit ALTER is what actually adds the description
    -- column to existing installations (same pattern as every other column).
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS description TEXT;

    -- ── SHOP: per-print sale settings ──────────────────────────────
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS for_sale BOOLEAN DEFAULT FALSE;
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS edition_type TEXT DEFAULT 'open'; -- 'open' or 'limited'
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS edition_size INTEGER; -- e.g. 25, only used if limited
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS delivery_ch BOOLEAN DEFAULT TRUE;
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS delivery_personal BOOLEAN DEFAULT FALSE;
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS delivery_intl BOOLEAN DEFAULT FALSE;
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS shop_note TEXT; -- print/paper description shown in shop detail (legacy, replaced by paper_id)
    -- Per-print flag: this print is sold WITHOUT the bottom-weighted margin
    -- (some images read better full-bleed). Shown on the shop with an
    -- explanatory note (text editable via the shop_no_margin_note content key).
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS no_margin BOOLEAN DEFAULT FALSE;
    -- Optional "in situ" lifestyle photo (e.g. the print framed on a living-room
    -- wall). Shown as an extra slide in the shop viewer when set. Its Cloudinary
    -- public_id is stored too so it can be deleted/replaced cleanly.
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS lifestyle_image_url TEXT;
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS lifestyle_public_id TEXT;
    -- Hand-written image description (screen readers + image search). NULL = empty alt.
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS alt_text TEXT;

    -- ── PAPERS: reusable paper descriptions ────────────────────────────
    CREATE TABLE IF NOT EXISTS papers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,        -- e.g. "Hahnemühle Photo Rag Satin"
      description TEXT NOT NULL, -- shown to customer in shop detail
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE papers ADD COLUMN IF NOT EXISTS weight_gsm INTEGER; -- paper weight in g/m², used for shipping calculation
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS paper_id INTEGER REFERENCES papers(id) ON DELETE SET NULL;

    -- Shipping settings: editable weights and packaging parameters
    CREATE TABLE IF NOT EXISTS shipping_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- EU shipping rate brackets: (format, max_weight_g, price_chf_cents)
    CREATE TABLE IF NOT EXISTS eu_shipping_rates (
      id SERIAL PRIMARY KEY,
      format TEXT NOT NULL,       -- 'letter' or 'packet'
      max_weight_g INTEGER NOT NULL,
      price_chf_cents INTEGER NOT NULL,
      UNIQUE(format, max_weight_g)
    );

    -- Personal delivery zones (CH only)
    CREATE TABLE IF NOT EXISTS personal_delivery_rates (
      id SERIAL PRIMARY KEY,
      zone TEXT NOT NULL UNIQUE,  -- e.g. 'canton_zurich', 'rest_of_switzerland'
      label TEXT NOT NULL,
      price_chf_cents INTEGER NOT NULL
    );

    -- Per-print, per-size pricing & remaining stock for limited editions
    CREATE TABLE IF NOT EXISTS print_sizes (
      id SERIAL PRIMARY KEY,
      print_id INTEGER REFERENCES prints(id) ON DELETE CASCADE,
      size TEXT NOT NULL, -- 'A4', 'A3', 'A2'
      price_chf INTEGER NOT NULL, -- stored in cents (CHF * 100)
      enabled BOOLEAN DEFAULT TRUE,
      edition_sold INTEGER DEFAULT 0, -- only relevant if print.edition_type = 'limited'
      UNIQUE(print_id, size)
    );

    -- FAQ items — fully editable (add / edit / remove / reorder) via admin,
    -- grouped into sections. Replaces the old hardcoded content-key FAQ.
    CREATE TABLE IF NOT EXISTS faqs (
      id SERIAL PRIMARY KEY,
      section TEXT NOT NULL DEFAULT 'General',
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Shipping rates: one price per (delivery method × size). Size-aware because
    -- A4 ships flat (cheap), A3/A2 ship rolled in a tube (pricier).
    CREATE TABLE IF NOT EXISTS shipping_rates (
      id SERIAL PRIMARY KEY,
      delivery_method TEXT NOT NULL, -- 'ch', 'personal', 'intl'
      size TEXT NOT NULL,            -- 'A4', 'A3', 'A2'
      price_chf INTEGER NOT NULL DEFAULT 0,
      UNIQUE(delivery_method, size)
    );

    -- Orders
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_ref TEXT UNIQUE, -- short human-readable reference, e.g. BHT-7K2X9P
      stripe_session_id TEXT UNIQUE,
      stripe_payment_intent TEXT,
      status TEXT DEFAULT 'pending', -- pending, paid, fulfilled, cancelled
      customer_name TEXT,
      customer_email TEXT,
      shipping_address JSONB,
      delivery_method TEXT, -- 'ch', 'personal', 'intl'
      delivery_price_chf INTEGER,
      subtotal_chf INTEGER,
      total_chf INTEGER,
      fulfilment_checklist JSONB DEFAULT '{}'::jsonb, -- e.g. {"printed":true,"packaged":false,"shipped":false,"shipping_email_sent":false}
      notes TEXT, -- free-text field for your own reference, not shown to the customer
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_ref TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilment_checklist JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;

    -- Order line items
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      print_id INTEGER REFERENCES prints(id),
      print_title TEXT,
      size TEXT,
      price_chf INTEGER,
      customer_note TEXT, -- optional note from the customer for this specific print
      edition_number INTEGER -- assigned at fulfilment time for limited editions
    );
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS customer_note TEXT;
    CREATE TABLE IF NOT EXISTS pageviews (
      id SERIAL PRIMARY KEY,
      visited_at TIMESTAMPTZ DEFAULT NOW(),
      path TEXT DEFAULT '/',
      referrer TEXT
    );
    ALTER TABLE pageviews ADD COLUMN IF NOT EXISTS referrer TEXT;

    CREATE TABLE IF NOT EXISTS photo_views (
      id SERIAL PRIMARY KEY,
      print_id INTEGER REFERENCES prints(id) ON DELETE CASCADE,
      viewed_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      interest TEXT,
      message TEXT,
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workshop_dates (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 6,
      price_chf_cents INTEGER NOT NULL DEFAULT 30000,
      frame_price_chf_cents INTEGER, -- optional add-on, NULL = not offered yet
      status TEXT NOT NULL DEFAULT 'draft', -- draft | open | closed | past
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workshop_bookings (
      id SERIAL PRIMARY KEY,
      booking_ref TEXT UNIQUE, -- short human-readable reference, e.g. WSH-7K2X9P
      workshop_date_id INTEGER REFERENCES workshop_dates(id),
      stripe_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | cancelled | refunded
      customer_name TEXT,
      customer_email TEXT,
      frame BOOLEAN DEFAULT FALSE,
      dietary TEXT,
      notes TEXT,
      amount_chf_cents INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workshop_photos (
      id SERIAL PRIMARY KEY,
      image_url TEXT NOT NULL,
      public_id TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── CLIENT PROOFING ──────────────────────────────────────────────────────
    -- Private, password-protected review boards for commissioned work, one per
    -- client, at /client/<slug>. The client sees only their own board; nothing
    -- here is linked from the public site, indexed, or in the sitemap.
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,        -- URL segment, e.g. 'drschuetz'
      name TEXT NOT NULL,               -- big heading at the top of the board
      eyebrow TEXT,                     -- small line above it; NULL = default studio line
      intro TEXT,                       -- optional note to the client, editable inline
      password_hash TEXT,               -- bcrypt; NULL = board locked, nobody can log in
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS eyebrow TEXT;

    -- Rooms group spots ("Empfang" → "Wand hinter Tresen", "Fensterseite").
    CREATE TABLE IF NOT EXISTS client_rooms (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      note TEXT,                        -- your own comment, shown to the client
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE client_rooms ADD COLUMN IF NOT EXISTS note TEXT;

    -- A spot is one physical position that needs one photo. Several candidate
    -- photos hang off it; the client reacts to each one independently.
    CREATE TABLE IF NOT EXISTS client_spots (
      id SERIAL PRIMARY KEY,
      room_id INTEGER REFERENCES client_rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      note TEXT,                        -- e.g. "Querformat, ca. 70cm breit"
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Candidate photos. status/comment are the client's own reaction, written
    -- straight onto the row — one client per board means no separate feedback
    -- table is needed. reacted_at drives the "new feedback" badge for admin.
    CREATE TABLE IF NOT EXISTS client_photos (
      id SERIAL PRIMARY KEY,
      spot_id INTEGER REFERENCES client_spots(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      public_id TEXT,
      note TEXT,                        -- your own comment, shown to the client
      sort_order INTEGER DEFAULT 0,
      series TEXT,                      -- optional series tag; NULL = untagged
      original_name TEXT,               -- filename as uploaded; admin-only, never sent to the client
      status TEXT DEFAULT 'pending',    -- pending | approved | declined
      client_comment TEXT,
      reacted_at TIMESTAMPTZ,
      seen_by_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- 'caption' shipped in the first version of this feature but was never
    -- surfaced in the UI; it becomes 'note' so photos match rooms and spots.
    -- Guarded so the rename runs at most once and never on a fresh database.
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='client_photos' AND column_name='caption')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='client_photos' AND column_name='note')
      THEN ALTER TABLE client_photos RENAME COLUMN caption TO note; END IF;
    END $$;
    ALTER TABLE client_photos ADD COLUMN IF NOT EXISTS note TEXT;
    -- Captured from Cloudinary at upload so the gallery can lay each photo out
    -- at its true aspect ratio on first paint. Measuring in the browser instead
    -- would reflow the whole grid as images arrive.
    ALTER TABLE client_photos ADD COLUMN IF NOT EXISTS width INTEGER;
    ALTER TABLE client_photos ADD COLUMN IF NOT EXISTS height INTEGER;
    -- Which series ("Serie A", "Schwarzweiss", …) a candidate belongs to. Free
    -- text rather than its own table: the board's chip row is derived from the
    -- distinct values actually present, so there is no list to keep in sync and
    -- a typo shows up immediately as an extra chip. NULL = untagged.
    ALTER TABLE client_photos ADD COLUMN IF NOT EXISTS series TEXT;
    -- The filename as it came off the card ("_DSC4821.jpg"), so a photo on the
    -- board can be traced back to the original. Shown to the photographer only
    -- and stripped from the client's payload. NULL on anything uploaded before
    -- this column existed — the board falls back to the Cloudinary id there.
    ALTER TABLE client_photos ADD COLUMN IF NOT EXISTS original_name TEXT;
    CREATE INDEX IF NOT EXISTS idx_client_rooms_client ON client_rooms(client_id);
    CREATE INDEX IF NOT EXISTS idx_client_spots_room ON client_spots(room_id);
    CREATE INDEX IF NOT EXISTS idx_client_photos_spot ON client_photos(spot_id);
  `);

  // Step 2: seed default content with parameterised queries
  const defaults = [
    ['hero_eyebrow', 'Zürich · Wiedikon · Fine Art Print'],
    ['hero_tagline', 'I make photographs and print them. From a small atelier in Wiedikon.'],
    ['hero_meta', 'Photography · Fine art print · Zürich'],
    ['hero_name_1', 'Bharat'],
    ['hero_name_2', 'Bhatia'],
    ['nav_name', 'Bharat Bhatia'],
    ['about_p1', "I make photographs and print them. There's a gap between an image on a screen and an image on paper — in the weight of it, the texture, the light it holds. My work lives in that gap."],
    ['about_p2', 'I work across ICM, abstract, street, and macro. Most of what I make is in black and white, though colour finds its way in when it earns it.'],
    ['about_p3', 'Based in Wiedikon, Zürich. I work from a small atelier with a fully colour-calibrated setup on an Epson SC-P900 — up to A2, across a range of fine art papers.'],
    ['about_p4', ''],
    ['atelier_eyebrow', 'The space'],
    ['atelier_headline', 'A small room. A lot of paper.'],
    ['atelier_p1', "I do the slow work here — proofing, calibrating, printing, looking. It's not a lab. It doesn't need to be fast."],
    ['atelier_p2', 'I print on an Epson SC-P900 on a range of fine art papers — each one profiled individually, each print checked by hand. Occasionally I help others print their work too.'],
    ['atelier_spec', 'Epson SC-P900 · 10-channel pigment ink · Up to A2 · Photo Rag Pearl · Mono Silk Warmtone · Photo Rag Satin & more'],
    ['paper1_name', 'Photo Rag Pearl'],
    ['paper1_desc', 'Warm matte surface with a pearlescent sheen. Deep blacks, beautiful highlight gradation. My default for colour work.'],
    ['paper1_best', 'Colour photography'],
    ['paper2_name', 'Photo Rag Satin'],
    ['paper2_desc', 'Smooth satin finish, wide gamut, excellent shadow depth. Works across photography and digital art.'],
    ['paper2_best', 'Colour & digital'],
    ['paper3_name', 'Mono Silk Warmtone'],
    ['paper3_desc', 'Made for black & white. Warm base, silky surface, darkroom-quality tonal range.'],
    ['paper3_best', 'Black & white'],
    ['papers_also', 'Other stocks available on request — just ask.'],
    ['contact_eyebrow', 'Contact'],
    ['contact_title', 'Say hello.'],
    ['contact_intro', 'Always happy to hear from people — about printing, photography, or just a conversation.'],
    ['footer_copy', '© 2025 · Zürich Wiedikon'],
    ['hero_image_url', ''],
    ['work_eyebrow', 'Work'],
    ['work_title', 'From the atelier.'],
    ['nav_shop', 'Shop'],
    ['shop_heading', 'Shop.'],
    ['shop_intro', 'Fine art prints from the atelier. Each one printed by hand on museum-grade paper. Shipped rolled in a tube (A3/A2) or flat-mailed (A4) — or pick up in person in Zürich.'],
    ['shop_p2', ''],
    ['shop_p3', ''],
    ['shop_cart_heading', 'Your cart.'],
    ['shop_success_heading', 'Thank you.'],
    ['shop_continue_btn', 'Continue browsing'],
    // Impressum
    ['impressum_name',       'Bharat Bhatia'],
    ['impressum_address',    'Atelier Bhatia\nQuellenstrasse 25\n8005 Zürich\nSwitzerland'],
    ['impressum_email',      'support@bharatbhatia.photography'],
    ['impressum_vat',        'Not VAT registered. Annual turnover below the Swiss CHF 100,000 threshold.'],
    ['impressum_disclaimer', 'All prints are produced and sold by Bharat Bhatia as an individual. All images on this site are copyright Bharat Bhatia. Reproduction without written permission is prohibited.'],
    // FAQ answers
    ['faq_paper', 'Each print is produced on museum-grade fine art paper — the specific paper for each image is noted in the shop. I use archival papers such as Hahnemühle Photo Rag and similar. The paper choice is made per image to best complement the photograph.'],
    ['faq_sizes', 'Prints are available in A4, A3, and A2 — standard DIN paper sizes. A4 is approximately 21×30cm, A3 is 30×42cm, and A2 is 42×60cm. Not all sizes are available for every image; available sizes and prices are shown per print in the shop.'],
    ['faq_signed', 'Yes. All prints are signed by hand. Limited edition prints are also numbered.'],
    ['faq_limited', 'A limited edition means only a fixed number of that print will ever be produced in that size. The edition size is shown in the shop. Once the edition sells out, no more copies of that print in that size will be made. Your edition number is recorded at the time of purchase.'],
    ['faq_limited_platforms', 'Some limited editions are also offered through other platforms, such as Artfinder. The edition size is shared across all of them — if a print has an edition of 50, that\'s 50 total, not 50 per platform. Every sale, wherever it happens, is recorded against the same running number, so the edition limit is always honoured and no print is ever oversold. A print may also be available as an open edition on this site even if a limited edition of it is listed elsewhere — the two are always clearly distinguished, and only the limited version is signed, numbered, and capped.'],
    ['faq_margin', 'Yes — all prints are delivered with a white border, heavier at the bottom (classic passepartout proportions). If you\'d prefer something different — equal margins, no margins, or a custom layout — just let me know in the notes field when ordering and I\'ll accommodate it.'],
    ['faq_how_order', 'Browse the shop, select a print and size, add it to your cart, choose a delivery method, and proceed to checkout. Payment is handled securely by Stripe — your card details are never seen or stored by me.'],
    ['faq_payment', 'Credit and debit cards (Visa, Mastercard, Amex) and TWINT for Swiss customers. All payments are processed securely via Stripe.'],
    ['faq_custom_print', 'Yes — if you\'ve seen a photo in my portfolio that isn\'t currently available as a print, just get in touch and I\'ll arrange it for you.'],
    ['faq_packaging', 'A4 prints are sent flat in a rigid protective mailer. A3 and A2 prints are shipped rolled in a sturdy postal tube. All prints are carefully packaged to arrive in perfect condition.'],
    ['faq_delivery_time', 'I aim to print and dispatch every order within one to two weeks of payment. Swiss delivery typically takes 2–4 working days after dispatch; EU and international delivery takes longer depending on destination. You\'ll receive a confirmation email when your order ships.'],
    ['faq_intl', 'Yes — I ship to EU countries and a range of other destinations worldwide. Shipping cost is calculated at checkout based on your country and the size of your order. For destinations not listed at checkout, contact me for a quote.'],
    ['faq_shipping_cost', 'Shipping is calculated automatically at checkout based on your delivery method, destination, and the size and weight of your prints. Swiss standard shipping starts from CHF 2 for A4 and CHF 9 for A3/A2. EU rates vary by weight — shown at checkout once you select your country.'],
    ['faq_personal_what', 'Personal delivery means I bring the print to you in person — no postal service, no tube. It\'s the most careful way to receive a large fine art print, and it gives us a chance to meet and make sure you\'re happy with the piece.'],
    ['faq_personal_where', 'Personal delivery is available across Switzerland and Liechtenstein. After placing your order, I\'ll contact you directly to arrange a time and location that works for you.'],
    ['faq_personal_how', 'Once your order is confirmed and the print is ready, I\'ll reach out by email to coordinate. We arrange a meeting point — your home, your office, or anywhere convenient. I bring the print in person, flat or rolled depending on size, and you can inspect it on the spot before I leave.'],
    ['faq_damaged', 'If your print arrives damaged, contact me as soon as possible with photos of the damage and packaging. I\'ll arrange a replacement or full refund, including return shipping costs, at no charge to you.'],
    ['faq_returns', 'Yes — you can return any print within 30 days of delivery, for any reason, no questions asked. Return shipping is at your cost; once the print arrives back in good condition I\'ll refund the full purchase price. See the terms of sale for full details.'],
    ['faq_framing', 'Not yet — but it\'s coming. I\'m in the process of learning to build my own frames by hand. Once available, framing will be offered as an optional add-on at checkout. Get in touch if you\'d like to know more or be notified when it launches.'],
    // Default note shown on the shop for prints flagged no_margin (editable)
    ['shop_no_margin_note', 'This print is produced full-bleed, without a border — this image is stronger edge to edge.'],
    // Toggle: show the subtle "Available as print" badge on hover over feed
    // photos that are for sale. 'on' or 'off'.
    ['feed_show_print_badge', 'on'],
    // FAQ visibility flags — 'false' hides that question on the site
    ['faq_paper_enabled','true'],['faq_sizes_enabled','true'],['faq_signed_enabled','true'],
    ['faq_limited_enabled','true'],['faq_limited_platforms_enabled','true'],['faq_margin_enabled','true'],['faq_how_order_enabled','true'],
    ['faq_payment_enabled','true'],['faq_custom_print_enabled','true'],['faq_packaging_enabled','true'],
    ['faq_delivery_time_enabled','true'],['faq_intl_enabled','true'],['faq_shipping_cost_enabled','true'],
    ['faq_personal_what_enabled','true'],['faq_personal_where_enabled','true'],['faq_personal_how_enabled','true'],
    ['faq_damaged_enabled','true'],['faq_returns_enabled','true'],['faq_framing_enabled','true'],
    // Workshop page — every visible text editable from admin
    ['workshop_banner_enabled', 'true'],
    ['workshop_banner_text', 'This page is a work in progress — dates and booking are not live yet.'],
    ['workshop_heading', 'Workshop.'],
    ['workshop_sub', 'Photo to print · A full day of abstract photography in Zürich, ending with your own A2 fine art print.'],
    ['workshop_intro', 'One day, six people, one photograph. We spend the morning shooting intentional camera movement and abstract work on a planned route through Zürich, then bring the day into the atelier: culling, editing, proofing on paper, and printing your strongest frame on A2 museum-grade fine art paper. You don\'t leave with theory — you leave with a print.'],
    ['workshop_schedule', '09:00 — Arrival at the atelier. Coffee, introductions, and a look at real prints.\n09:30 — Intentional camera movement: technique, prompts, and what to look for.\n10:15 — Photowalk. A pre-planned route through Zürich, shooting as we go.\n13:00 — Lunch together, included.\n14:00 — Culling and editing at the atelier. Narrowing down to your two strongest frames.\n15:30 — Hard proofs on A4. We review every print together, on paper, under neutral light.\n16:30 — Final edits on your winning photograph.\n17:00 — Your photo goes to print on A2 museum-grade paper — shipped to your door in the days after.'],
    ['workshop_included', 'A full day of guided shooting and one-on-one feedback\nCoffee and lunch\nAll materials — A4 proof prints and your final A2 fine art print\nShipping of your A2 print anywhere in Switzerland or Liechtenstein\nLoaner ND and creative filters in common thread sizes'],
    ['workshop_bring', 'A camera you can control fully manually — no smartphones or analog for this one\nYour laptop with your editing software of choice, and your card reader\nND or creative filters if you own any\nComfortable shoes — we walk for a few hours, whatever the weather'],
    ['workshop_weather', 'The workshop runs rain or shine — Zürich in bad weather makes better abstract photographs than postcards do. Only genuinely extreme conditions lead to a reschedule, in which case you\'ll be offered the next date or a full refund.'],
    ['workshop_min', 'The workshop runs with a minimum of 4 participants. If a date doesn\'t reach the minimum, you\'ll be offered the next date or a full refund.'],
    ['workshop_price_note', 'CHF 300 per person — everything included.'],
    ['workshop_cta', 'Book your spot'],
  ];

  for (const [key, value] of defaults) {
    await pool.query(
      'INSERT INTO content (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }

  // Step 3: seed default shipping rates (CHF cents) — editable later from admin
  const shippingDefaults = [
    ['ch', 'A4', 700],        // CHF 7.00 — flat mailer
    ['ch', 'A3', 900],        // CHF 9.00 — small tube
    ['ch', 'A2', 1200],       // CHF 12.00 — larger tube
    ['personal', 'A4', 4000], // CHF 40.00 — flat premium regardless of size
    ['personal', 'A3', 4000],
    ['personal', 'A2', 4000],
    ['intl', 'A4', 1500],     // CHF 15.00
    ['intl', 'A3', 2000],     // CHF 20.00
    ['intl', 'A2', 2500],     // CHF 25.00
  ];
  for (const [method, size, price] of shippingDefaults) {
    await pool.query(
      `INSERT INTO shipping_rates (delivery_method, size, price_chf) VALUES ($1,$2,$3)
       ON CONFLICT (delivery_method, size) DO NOTHING`,
      [method, size, price]
    );
  }

  // Seed shipping settings (editable from admin)
  const shippingSettingsDefaults = [
    ['tube_weight_a3_g',    '100'],   // empty A3 tube weight in grams
    ['tube_weight_a2_g',    '200'],   // empty A2 tube weight in grams
    ['envelope_weight_a4_g','50'],    // flat envelope weight in grams
    ['prints_per_tube',     '3'],     // max prints per tube
    ['ch_letter_price',     '200'],   // CHF 2.00 in cents
    ['ch_packet_price',     '900'],   // CHF 9.00 in cents
  ];
  for (const [key, value] of shippingSettingsDefaults) {
    await pool.query(
      `INSERT INTO shipping_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }

  // Seed EU shipping rates from post.ch tables
  const euRates = [
    // Letters (A4 flat, L+B+H ≤90cm)
    ['letter',  100,  430], // CHF 4.30
    ['letter',  250,  750], // CHF 7.50
    ['letter',  500, 1200], // CHF 12.00
    ['letter', 1000, 1900], // CHF 19.00
    ['letter', 2000, 2600], // CHF 26.00
    // Packets (A3/A2 rolled in tube, L+B+H ≤90cm)
    ['packet',  100,  450], // CHF 4.50
    ['packet',  250,  950], // CHF 9.50
    ['packet',  500, 1450], // CHF 14.50
    ['packet', 1000, 2050], // CHF 20.50
    ['packet', 1500, 2550], // CHF 25.50
    ['packet', 2000, 3050], // CHF 30.50
  ];
  for (const [format, max_weight_g, price_chf_cents] of euRates) {
    await pool.query(
      `INSERT INTO eu_shipping_rates (format, max_weight_g, price_chf_cents)
       VALUES ($1,$2,$3) ON CONFLICT (format, max_weight_g) DO NOTHING`,
      [format, max_weight_g, price_chf_cents]
    );
  }

  // Seed personal delivery — single flat rate for all CH/LI
  const personalDeliveryDefaults = [
    ['ch_li', 'Switzerland & Liechtenstein', 5000],  // CHF 50 flat
  ];
  // Clean up old personal delivery zones, keep only ch_li
  await pool.query(`DELETE FROM personal_delivery_rates WHERE zone NOT IN ('ch_li')`);

  for (const [zone, label, price] of personalDeliveryDefaults) {
    await pool.query(
      `INSERT INTO personal_delivery_rates (zone, label, price_chf_cents)
       VALUES ($1,$2,$3) ON CONFLICT (zone) DO NOTHING`,
      [zone, label, price]
    );
  }

  // Seed categories — but ONLY on a genuinely empty table (i.e. the very
  // first time this ever runs). This used to run unconditionally on every
  // server start; ON CONFLICT (slug) DO NOTHING only guards against
  // duplicating a slug that still exists, so renaming or deleting a default
  // category in admin (e.g. "Abstract" from abstract-bnw → abstract) freed
  // up the old slug, and the next deploy quietly recreated a disconnected
  // phantom "Abstract"/abstract-bnw row. Gating on an empty table means this
  // fires once ever, and every admin change to categories afterward sticks
  // permanently across restarts and deploys.
  const { rows: existingCatCount } = await pool.query('SELECT COUNT(*)::int AS n FROM categories');
  if (existingCatCount[0].n === 0) {
    const categoryDefaults = [
      ['abstract-bnw',  'Abstract'],
      ['macro',         'Macro'],
      ['travel',        'Travel'],
      ['portrait',      'Portrait'],
      ['street',        'Street'],
      ['street-lights', 'Street Lights'],
      ['other',         'Other'],
    ];
    for (let i = 0; i < categoryDefaults.length; i++) {
      const [slug, label] = categoryDefaults[i];
      await pool.query(
        `INSERT INTO categories (slug, label, sort_order)
         VALUES ($1,$2,$3) ON CONFLICT (slug) DO NOTHING`,
        [slug, label, i]
      );
    }
  }

  // Seed FAQ items once, only if the table is empty (so deleting a seeded item
  // in admin doesn't resurrect it on the next deploy). Migrates the previous
  // hardcoded FAQ set verbatim and adds the workshop questions.
  const { rows: faqCount } = await pool.query('SELECT COUNT(*)::int AS n FROM faqs');
  if (faqCount[0].n === 0) {
    const faqDefaults = [
      // section, question, answer
      ['Prints & paper', 'What paper are the prints made on?', 'Each print is produced on museum-grade fine art paper — the specific paper for each image is noted in the shop. I use archival papers such as Hahnemühle Photo Rag and similar. The paper choice is made per image to best complement the photograph.'],
      ['Prints & paper', 'What sizes are available?', 'Prints are available in A4, A3, and A2 — standard DIN paper sizes. A4 is approximately 21×30cm, A3 is 30×42cm, and A2 is 42×60cm. Not all sizes are available for every image; available sizes and prices are shown per print in the shop.'],
      ['Prints & paper', 'Are the prints signed?', 'Yes. All prints are signed by hand. Limited edition prints are also numbered.'],
      ['Prints & paper', 'What is a limited edition print?', 'A limited edition means only a fixed number of that print will ever be produced in that size. The edition size is shown in the shop. Once the edition sells out, no more copies of that print in that size will be made. Your edition number is recorded at the time of purchase.'],
      ['Prints & paper', 'Are your limited editions honoured across different platforms?', 'Some limited editions are also offered through other platforms, such as Artfinder. The edition size is shared across all of them — if a print has an edition of 50, that\'s 50 total, not 50 per platform. Every sale, wherever it happens, is recorded against the same running number, so the edition limit is always honoured and no print is ever oversold. A print may also be available as an open edition on this site even if a limited edition of it is listed elsewhere — the two are always clearly distinguished, and only the limited version is signed, numbered, and capped.'],
      ['Prints & paper', 'Will prints have a margin / passepartout?', 'Yes — all prints are delivered with a white border, heavier at the bottom (classic passepartout proportions). If you\'d prefer something different — equal margins, no margins, or a custom layout — just let me know in the notes field when ordering and I\'ll accommodate it.'],
      ['Ordering & payment', 'How do I order?', 'Browse the shop, select a print and size, add it to your cart, choose a delivery method, and proceed to checkout. Payment is handled securely by Stripe — your card details are never seen or stored by me.'],
      ['Ordering & payment', 'What payment methods do you accept?', 'Credit and debit cards (Visa, Mastercard, Amex) and TWINT for Swiss customers. All payments are processed securely via Stripe.'],
      ['Ordering & payment', 'Can I order a print that isn\'t in the shop?', 'Yes — if you\'ve seen a photo in my portfolio that isn\'t currently available as a print, just get in touch and I\'ll arrange it for you.'],
      ['Shipping & delivery', 'How are prints shipped?', 'A4 prints are sent flat in a rigid protective mailer. A3 and A2 prints are shipped rolled in a sturdy postal tube. All prints are carefully packaged to arrive in perfect condition.'],
      ['Shipping & delivery', 'How long does delivery take?', 'I aim to print and dispatch every order within one to two weeks of payment. Swiss delivery typically takes 2–4 working days after dispatch; EU and international delivery takes longer depending on destination. You\'ll receive a confirmation email when your order ships.'],
      ['Shipping & delivery', 'Do you ship internationally?', 'Yes — I ship to EU countries and a range of other destinations worldwide. Shipping cost is calculated at checkout based on your country and the size of your order. For destinations not listed at checkout, contact me for a quote.'],
      ['Shipping & delivery', 'How much does shipping cost?', 'Shipping is calculated automatically at checkout based on your delivery method, destination, and the size and weight of your prints. Swiss standard shipping starts from CHF 2 for A4 and CHF 9 for A3/A2. EU rates vary by weight — shown at checkout once you select your country.'],
      ['Personal delivery', 'What is personal delivery?', 'Personal delivery means I bring the print to you in person — no postal service, no tube. It\'s the most careful way to receive a large fine art print, and it gives us a chance to meet and make sure you\'re happy with the piece.'],
      ['Personal delivery', 'Where is personal delivery available?', 'Personal delivery is available across Switzerland and Liechtenstein. After placing your order, I\'ll contact you directly to arrange a time and location that works for you.'],
      ['Personal delivery', 'How does personal delivery work?', 'Once your order is confirmed and the print is ready, I\'ll reach out by email to coordinate. We arrange a meeting point — your home, your office, or anywhere convenient. I bring the print in person, flat or rolled depending on size, and you can inspect it on the spot before I leave.'],
      ['Returns & issues', 'What if my print arrives damaged?', 'If your print arrives damaged, contact me as soon as possible with photos of the damage and packaging. I\'ll arrange a replacement or full refund, including return shipping costs, at no charge to you.'],
      ['Returns & issues', 'Can I return a print?', 'Yes — you can return any print within 30 days of delivery, for any reason, no questions asked. Return shipping is at your cost; once the print arrives back in good condition I\'ll refund the full purchase price. See the terms of sale for full details.'],
      ['Framing', 'Do you offer framing?', 'Not yet — but it\'s coming. I\'m in the process of learning to build my own frames by hand. Once available, framing will be offered as an optional add-on at checkout. Get in touch if you\'d like to know more or be notified when it launches.'],
      // Workshop Q&As (new)
      ['Workshops', 'What is the "Photo to Print" workshop?', 'A full-day workshop where we go out and shoot together around a creative theme, then return to my atelier and produce a finished fine art print of your work — from camera to a large-format archival print you take home. It combines a guided photo walk with hands-on exposure to a real colour-managed printing workflow.'],
      ['Workshops', 'Do I need my own camera and experience?', 'You\'ll need a camera you can control manually — a DSLR or mirrorless where you can set aperture, shutter, and ISO. The workshop suits enthusiastic beginners through to experienced photographers; it\'s about seeing and making, not about gear or technical perfection. Phone-only or fully-automatic shooting isn\'t the right fit for this particular day.'],
      ['Workshops', 'What\'s included, and what does it cost?', 'The day includes the guided shoot, individual consultation on selecting and preparing your image, and one large-format fine art print of your chosen photograph produced in my atelier. Group sizes are kept small so everyone gets real attention. Pricing and available dates are shown on the workshop page — get in touch if you\'d like to be notified of upcoming dates.'],
      ['Workshops', 'When do I get my print?', 'Because each print is produced with a full colour-managed workflow to the same standard as my commissioned work, it\'s prepared with care after the workshop rather than rushed on the day. I\'ll finish and dispatch (or arrange personal handover of) your print shortly after — so you leave with the experience and receive the finished piece soon after.'],
    ];
    for (let i = 0; i < faqDefaults.length; i++) {
      const [section, question, answer] = faqDefaults[i];
      await pool.query(
        'INSERT INTO faqs (section, question, answer, sort_order) VALUES ($1,$2,$3,$4)',
        [section, question, answer, i]
      );
    }
  }

  // Seed the first client board once, only on a genuinely empty table, so
  // deleting it in admin doesn't resurrect it on the next deploy. No password
  // is set here — the board stays locked until one is set from the admin view.
  const { rows: clientCount } = await pool.query('SELECT COUNT(*)::int AS n FROM clients');
  if (clientCount[0].n === 0) {
    await pool.query(
      `INSERT INTO clients (slug, name, intro) VALUES ($1,$2,$3) ON CONFLICT (slug) DO NOTHING`,
      ['drschuetz', 'Dr. Schütz', 'Eine Auswahl möglicher Bilder für Ihre Praxis. Bitte markieren Sie zu jedem Platz, was Ihnen gefällt — ein Kommentar genügt, wenn etwas anders sein soll.']
    );
  }

  console.log('DB initialised');
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.admin) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

// Client-board access. A client session is a SEPARATE role from admin: logging
// in as a client never grants admin rights, and it is scoped to one slug, so a
// client session can't read another client's board. Admin sees every board.
function requireBoardAccess(req, res, next) {
  const slug = req.params.slug;
  if (req.session.admin) { req.isBoardAdmin = true; return next(); }
  if (req.session.client_slug && req.session.client_slug === slug) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

// Resolves a client board by slug, 404s if unknown.
async function getClient(slug) {
  const { rows } = await pool.query('SELECT * FROM clients WHERE slug=$1', [slug]);
  return rows[0] || null;
}

// Walks a photo id back up to its owning client — used to authorise mutations
// on nested resources, which carry only their own id in the URL.
async function clientForPhoto(photoId) {
  const { rows } = await pool.query(
    `SELECT c.* FROM client_photos p
       JOIN client_spots s ON s.id = p.spot_id
       JOIN client_rooms r ON r.id = s.room_id
       JOIN clients c ON c.id = r.client_id
      WHERE p.id = $1`, [photoId]
  );
  return rows[0] || null;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
app.get('/api/content', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM content');
    const content = {};
    rows.forEach(r => { content[r.key] = r.value; });
    res.json(content);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public: enabled FAQ items, ordered. The frontend groups them by section.
app.get('/api/faqs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, section, question, answer FROM faqs WHERE enabled = TRUE ORDER BY sort_order ASC, id ASC'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/prints', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, title, description, image_url, public_id, sort_order, exclude_from_hero, exclude_from_category_hero, category, categories, for_sale, alt_text, created_at FROM prints ORDER BY sort_order ASC, created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Single source of truth for category slugs/labels/order — used by the
// public nav filter dropdown AND the admin per-print tagging checkboxes, so
// the two can never drift out of sync the way two hardcoded arrays used to.
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, slug, label, description, sort_order FROM categories ORDER BY sort_order ASC, id ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SHOP: PUBLIC ──────────────────────────────────────────────────────────────
// List all prints currently for sale, with their sizes/prices/availability
app.get('/api/shop/products', async (req, res) => {
  try {
    const { rows: prints } = await pool.query(
      `SELECT p.id, p.title, p.description, p.image_url, p.edition_type, p.edition_size,
              p.delivery_ch, p.delivery_personal, p.delivery_intl, p.shop_note, p.no_margin, p.lifestyle_image_url, p.alt_text,
              pa.name AS paper_name, pa.description AS paper_description
       FROM prints p
       LEFT JOIN papers pa ON pa.id = p.paper_id
       WHERE p.for_sale = TRUE ORDER BY p.sort_order ASC`
    );
    const { rows: sizes } = await pool.query(
      `SELECT print_id, size, price_chf, enabled, edition_sold FROM print_sizes WHERE enabled = TRUE`
    );
    const products = prints.map(p => ({
      ...p,
      sizes: sizes.filter(s => s.print_id === p.id).map(s => ({
        size: s.size,
        price_chf: s.price_chf,
        sold_out: p.edition_type === 'limited' && p.edition_size != null && s.edition_sold >= p.edition_size,
        remaining: p.edition_type === 'limited' && p.edition_size != null ? Math.max(0, p.edition_size - s.edition_sold) : null,
      })),
    }));
    res.json(products);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public: current shipping rates, so the shop frontend can show prices before checkout
app.get('/api/shop/shipping-rates', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT delivery_method, size, price_chf FROM shipping_rates ORDER BY delivery_method, size');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Create a Stripe Checkout session for a cart
app.post('/api/shop/checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Shop is not configured yet' });
  const { items, delivery_method } = req.body; // items: [{print_id, size}], delivery_method: 'ch'|'personal'|'intl'
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty' });
  if (!DELIVERY_LABELS[delivery_method]) return res.status(400).json({ error: 'Invalid delivery method' });

  try {
    // Validate items & build Stripe line items from authoritative DB prices
    const lineItems = [];
    const orderItemsData = [];
    const sizesInCart = [];
    let subtotal = 0;

    // Counts how many units of each print+size have already passed validation
    // earlier in THIS loop. Needed now that a cart can hold multiple units of
    // the same limited edition (quantity stepper) — checking row.edition_sold
    // alone would let two cart entries for the last remaining slot both pass,
    // since neither iteration knows about the other.
    const countedInThisCart = {};

    for (const item of items) {
      const { rows } = await pool.query(
        `SELECT p.id, p.title, p.image_url, p.edition_type, p.edition_size,
                ps.size, ps.price_chf, ps.edition_sold,
                p.delivery_ch, p.delivery_personal, p.delivery_intl
         FROM prints p JOIN print_sizes ps ON ps.print_id = p.id
         WHERE p.id = $1 AND ps.size = $2 AND p.for_sale = TRUE AND ps.enabled = TRUE`,
        [item.print_id, item.size]
      );
      const row = rows[0];
      if (!row) return res.status(400).json({ error: `Item not available: ${item.print_id} ${item.size}` });

      const key = `${row.id}::${row.size}`;
      const alreadyCounted = countedInThisCart[key] || 0;
      if (row.edition_type === 'limited' && row.edition_size != null &&
          (row.edition_sold + alreadyCounted) >= row.edition_size) {
        return res.status(400).json({ error: `${row.title} (${row.size}) doesn't have that many copies left` });
      }
      countedInThisCart[key] = alreadyCounted + 1;

      const deliveryAllowed = { ch: row.delivery_ch, personal: row.delivery_personal, intl: row.delivery_intl };
      if (!deliveryAllowed[delivery_method]) {
        return res.status(400).json({ error: `${row.title} doesn't support that delivery method` });
      }

      lineItems.push({
        price_data: {
          currency: 'chf',
          product_data: { name: `${row.title} — ${row.size}`, images: [row.image_url] },
          unit_amount: row.price_chf,
        },
        quantity: 1,
      });
      orderItemsData.push({ print_id: row.id, print_title: row.title, size: row.size, price_chf: row.price_chf, note: item.note || null });
      sizesInCart.push(row.size);
      subtotal += row.price_chf;
    }

    // Weight-based shipping calculation using paper weights and packaging
    const enrichedItems = orderItemsData.map(oi => ({
      print_id: oi.print_id, size: oi.size,
      paper_weight_gsm: 200 // fallback; overridden below
    }));
    // Fetch actual paper weights
    for (const oi of orderItemsData) {
      const { rows: pw } = await pool.query(
        `SELECT pa.weight_gsm FROM prints p LEFT JOIN papers pa ON pa.id = p.paper_id WHERE p.id = $1`,
        [oi.print_id]
      );
      const matching = enrichedItems.find(e => e.print_id === oi.print_id && e.size === oi.size);
      if (matching) matching.paper_weight_gsm = pw[0]?.weight_gsm || 200;
    }

    const countryCode = req.body.country_code || 'CH';
    const zone = req.body.zone || null;
    const baseMethod = delivery_method.startsWith('personal_') ? 'personal' : delivery_method;
    const shippingResult = await calculateShipping(enrichedItems, baseMethod, countryCode, zone);
    if (shippingResult.requires_quote) {
      return res.status(400).json({ error: 'shipping_quote_required', message: shippingResult.label || 'Contact for shipping quote' });
    }
    const shippingPrice = shippingResult.price_chf_cents;

    // Add delivery as its own line item
    lineItems.push({
      price_data: {
        currency: 'chf',
        product_data: { name: DELIVERY_LABELS[delivery_method] },
        unit_amount: shippingPrice,
      },
      quantity: 1,
    });

    const total = subtotal + shippingPrice;
    const origin = req.headers.origin || `https://${req.headers.host}`;

    // Lock the Stripe address form to exactly the country the customer selected —
    // this prevents gaming shipping rates by entering a different address country.
    const CH_LI = ['CH', 'LI'];
    const EU_COUNTRIES_LIST = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE',
      'GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES',
      'SE','GB','IS','NO'];
    const baseDeliveryMethod = delivery_method.startsWith('personal') ? 'personal' : delivery_method;

    let allowedCountries;
    if (baseDeliveryMethod === 'ch' || baseDeliveryMethod === 'personal') {
      allowedCountries = CH_LI;
    } else if (baseDeliveryMethod === 'intl' && countryCode && countryCode !== 'CH' && countryCode !== 'LI') {
      const isEu = EU_COUNTRIES_LIST.includes(countryCode);
      allowedCountries = isEu ? EU_COUNTRIES_LIST : [countryCode];
    } else {
      allowedCountries = [...CH_LI, ...EU_COUNTRIES_LIST];
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'twint'],
      line_items: lineItems,
      shipping_address_collection: {
        allowed_countries: allowedCountries,
      },
      // Stripe needs an actual Customer object to attach an invoice to in
      // payment mode — without this, invoice_creation can silently no-op.
      customer_creation: 'always',
      // Generates a proper PDF invoice and emails it to the customer automatically
      // the moment payment succeeds — independent of our own Resend setup.
      invoice_creation: { enabled: true },
      success_url: `${origin}/shop/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/shop`,
    });

    // Pre-create the order record as pending, fill in once webhook confirms payment
    // Generate a unique human-readable reference (collisions are extremely
    // rare with this character set, but retry a couple of times just in case)
    let orderRef;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateOrderRef();
      const { rows: existing } = await pool.query('SELECT 1 FROM orders WHERE order_ref=$1', [candidate]);
      if (!existing.length) { orderRef = candidate; break; }
    }
    const orderRes = await pool.query(
      `INSERT INTO orders (order_ref, stripe_session_id, status, delivery_method, delivery_price_chf, subtotal_chf, total_chf)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6) RETURNING id`,
      [orderRef, session.id, delivery_method, shippingPrice, subtotal, total]
    );
    const orderId = orderRes.rows[0].id;
    for (const oi of orderItemsData) {
      await pool.query(
        `INSERT INTO order_items (order_id, print_id, print_title, size, price_chf, customer_note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, oi.print_id, oi.print_title, oi.size, oi.price_chf, oi.note || null]
      );
    }

    res.json({ url: session.url });
  } catch (e) {
    console.error('Checkout error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Fetch order details after successful checkout (for the success page)
app.get('/api/shop/order/:sessionId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE stripe_session_id = $1', [req.params.sessionId]);
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [rows[0].id]);

    // Update customer details from Stripe session if not yet stored
    if (stripe && !rows[0].customer_email) {
      try {
        const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
        if (session.customer_details) {
          const addressToStore = (session.shipping_details && session.shipping_details.address) || session.customer_details.address || {};
          await pool.query(
            `UPDATE orders SET customer_name=$1, customer_email=$2, shipping_address=$3 WHERE id=$4`,
            [session.customer_details.name, session.customer_details.email, JSON.stringify(addressToStore), rows[0].id]
          );
        }
      } catch (e) { /* non-fatal */ }
    }

    res.json({ order: rows[0], items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CONTACT FORM ──────────────────────────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { name, email, interest, message } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  console.log(`[ENQUIRY] ${name} <${email}> — ${interest || 'no category'}: ${message || ''}`);

  try {
    await pool.query(
      'INSERT INTO messages (name, email, interest, message) VALUES ($1, $2, $3, $4)',
      [name, email, interest || null, message || null]
    );
    console.log('[ENQUIRY] Stored in DB successfully');
  } catch(e) {
    console.error('[ENQUIRY] Failed to store message:', e.message);
    return res.status(500).json({ error: 'Failed to save message: ' + e.message });
  }

  if (!resend) {
    return res.json({ ok: true });
  }

  try {
    const to = process.env.EMAIL_TO || 'bhartu.bhatia@gmail.com';

    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'hello@bajiprints.ch',
      to,
      subject: `New print enquiry from ${name}`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 560px; color: #1A1714;">
          <h2 style="font-size: 1.4rem; margin-bottom: 1rem;">New enquiry — Baji Prints</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Looking to print:</strong> ${interest || 'Not specified'}</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 1rem 0;">
          <p style="white-space: pre-wrap;">${message || '(no message)'}</p>
        </div>
      `,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('Email error:', e);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── ADMIN AUTH ────────────────────────────────────────────────────────────────
// Throttle admin login: 10 failed attempts per 15 minutes per IP, then 429.
// Successful logins don't count against the window (skipSuccessfulRequests),
// so this only ever bites password-guessing bots, not you.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again in 15 minutes.' },
});

// Constant-time string compare (SHA-256 both sides so lengths never differ,
// avoiding both early-exit and length-leak timing). Used only for the legacy
// plaintext fallback below.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Admin auth. Prefers a bcrypt hash in ADMIN_PASSWORD_HASH. Until that's set,
// falls back to a constant-time compare against the plaintext ADMIN_PASSWORD so
// the existing Railway setup keeps working. Once ADMIN_PASSWORD_HASH is set and
// verified, delete ADMIN_PASSWORD. If neither is set, login fails closed.
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  const attempt = String(password || '');
  const hash = process.env.ADMIN_PASSWORD_HASH;
  const plain = process.env.ADMIN_PASSWORD;
  let match = false;
  try {
    if (hash) {
      match = await bcrypt.compare(attempt, hash);
    } else if (plain) {
      match = safeEqual(attempt, plain);
    }
  } catch (e) {
    match = false;
  }
  if (match) {
    req.session.admin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ authenticated: !!req.session.admin });
});

// ── ADMIN CONTENT ─────────────────────────────────────────────────────────────
app.put('/api/admin/content', requireAuth, async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  try {
    await pool.query(
      'INSERT INTO content (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
      [key, value]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN FAQ CRUD ────────────────────────────────────────────────────────────
// List ALL faqs (including disabled) for the admin panel.
app.get('/api/admin/faqs', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, section, question, answer, sort_order, enabled FROM faqs ORDER BY sort_order ASC, id ASC'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a new FAQ item — appended to the end.
app.post('/api/admin/faqs', requireAuth, async (req, res) => {
  const { section, question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required' });
  try {
    const { rows: maxRow } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM faqs');
    const { rows } = await pool.query(
      'INSERT INTO faqs (section, question, answer, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
      [section || 'General', question, answer, maxRow[0].next]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reorder — accepts an array of ids in the new order. MUST be before /:id.
app.put('/api/admin/faqs/reorder', requireAuth, async (req, res) => {
  const { order } = req.body; // array of faq ids
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query('UPDATE faqs SET sort_order = $1 WHERE id = $2', [i, order[i]]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update an existing FAQ item (any field).
app.put('/api/admin/faqs/:id', requireAuth, async (req, res) => {
  const { section, question, answer, enabled } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE faqs SET
         section = COALESCE($1, section),
         question = COALESCE($2, question),
         answer = COALESCE($3, answer),
         enabled = COALESCE($4, enabled)
       WHERE id = $5 RETURNING *`,
      [section ?? null, question ?? null, answer ?? null,
       (typeof enabled === 'boolean' ? enabled : null), req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'FAQ not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a FAQ item.
app.delete('/api/admin/faqs/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM faqs WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN IMAGE UPLOAD (hero) ─────────────────────────────────────────────────
app.post('/api/admin/upload/hero', requireAuth, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Multer/Cloudinary error:', err);
      return res.status(500).json({ error: err.message, detail: JSON.stringify(err) });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const url = req.file.path;
    await pool.query(
      "INSERT INTO content (key, value) VALUES ('hero_image_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [url]
    );
    res.json({ ok: true, url });
  } catch (e) {
    console.error('Hero upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN ABOUT PHOTO UPLOAD ──────────────────────────────────────────────────
app.post('/api/admin/upload/about-photo', requireAuth, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const url = req.file.path;
    await pool.query(
      "INSERT INTO content (key, value) VALUES ('about_photo_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [url]
    );
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN PRINTS ──────────────────────────────────────────────────────────────
app.post('/api/admin/prints', requireAuth, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Print upload error:', err);
      return res.status(500).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, async (req, res) => {
  const { title, description, sort_order } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  if (!title) return res.status(400).json({ error: 'Title required' });
  try {
    const url = req.file.path;
    const publicId = req.file.filename;
    console.log('Print uploaded:', url);
    const { rows } = await pool.query(
      'INSERT INTO prints (title, description, image_url, public_id, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, description || '', url, publicId, parseInt(sort_order) || 0]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('DB error saving print:', e);
    res.status(500).json({ error: e.message });
  }
});

// Replace the image on an existing print — uploads the new file, swaps
// image_url + public_id, and deletes the OLD Cloudinary asset so it doesn't
// orphan. All other fields (title, categories, sort order, for_sale, etc.)
// are untouched. Registered before /:id so the literal path wins.
app.put('/api/admin/prints/:id/image', requireAuth, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Print image replace error:', err);
      return res.status(500).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  try {
    // Grab the old public_id first so we can clean it up after the swap.
    const existing = await pool.query('SELECT public_id FROM prints WHERE id=$1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Print not found' });
    const oldPublicId = existing.rows[0].public_id;

    const url = req.file.path;
    const publicId = req.file.filename;
    const { rows } = await pool.query(
      'UPDATE prints SET image_url=$1, public_id=$2 WHERE id=$3 RETURNING *',
      [url, publicId, req.params.id]
    );

    // Delete the old asset (best-effort — don't fail the request if cleanup
    // hiccups, since the DB is already pointing at the new image).
    if (oldPublicId && oldPublicId !== publicId) {
      cloudinary.uploader.destroy(oldPublicId).catch(e =>
        console.error('Old image cleanup failed (non-fatal):', e.message));
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('DB error replacing print image:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/prints/reorder', requireAuth, async (req, res) => {
  const { order } = req.body; // array of print IDs in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of IDs' });
  try {
    await Promise.all(order.map((id, i) =>
      pool.query('UPDATE prints SET sort_order=$1 WHERE id=$2', [i, id])
    ));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload / replace the optional "in situ" lifestyle photo for a print.
app.put('/api/admin/prints/:id/lifestyle', requireAuth, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Lifestyle image upload error:', err);
      return res.status(500).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  try {
    const existing = await pool.query('SELECT lifestyle_public_id FROM prints WHERE id=$1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Print not found' });
    const oldPublicId = existing.rows[0].lifestyle_public_id;
    const { rows } = await pool.query(
      'UPDATE prints SET lifestyle_image_url=$1, lifestyle_public_id=$2 WHERE id=$3 RETURNING lifestyle_image_url',
      [req.file.path, req.file.filename, req.params.id]
    );
    if (oldPublicId && oldPublicId !== req.file.filename) {
      cloudinary.uploader.destroy(oldPublicId).catch(e =>
        console.error('Old lifestyle image cleanup failed (non-fatal):', e.message));
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('DB error saving lifestyle image:', e);
    res.status(500).json({ error: e.message });
  }
});

// Remove the lifestyle photo from a print.
app.delete('/api/admin/prints/:id/lifestyle', requireAuth, async (req, res) => {
  try {
    const existing = await pool.query('SELECT lifestyle_public_id FROM prints WHERE id=$1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Print not found' });
    const oldPublicId = existing.rows[0].lifestyle_public_id;
    await pool.query('UPDATE prints SET lifestyle_image_url=NULL, lifestyle_public_id=NULL WHERE id=$1', [req.params.id]);
    if (oldPublicId) {
      cloudinary.uploader.destroy(oldPublicId).catch(e =>
        console.error('Lifestyle image cleanup failed (non-fatal):', e.message));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/prints/:id', requireAuth, async (req, res) => {
  const { title, description, sort_order, exclude_from_hero, exclude_from_category_hero, category, categories, alt_text } = req.body;
  // categories is the new multi-value array; category is the legacy single string kept for compatibility
  const cats = Array.isArray(categories) && categories.length ? categories : [category || 'abstract-bnw'];
  const primaryCat = cats[0]; // keep legacy category column in sync with first selection
  const alt = (typeof alt_text === 'string' && alt_text.trim()) ? alt_text.trim() : null;
  try {
    let query, params;
    if (sort_order !== undefined) {
      query = 'UPDATE prints SET title=$1, description=$2, sort_order=$3, exclude_from_hero=$4, exclude_from_category_hero=$5, category=$6, categories=$7, alt_text=$8 WHERE id=$9 RETURNING *';
      params = [title, description, parseInt(sort_order) || 0, !!exclude_from_hero, !!exclude_from_category_hero, primaryCat, JSON.stringify(cats), alt, req.params.id];
    } else {
      query = 'UPDATE prints SET title=$1, description=$2, exclude_from_hero=$3, exclude_from_category_hero=$4, category=$5, categories=$6, alt_text=$7 WHERE id=$8 RETURNING *';
      params = [title, description, !!exclude_from_hero, !!exclude_from_category_hero, primaryCat, JSON.stringify(cats), alt, req.params.id];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/prints/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT public_id FROM prints WHERE id=$1', [req.params.id]);
    if (rows[0]) await cloudinary.uploader.destroy(rows[0].public_id);
    await pool.query('DELETE FROM prints WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN CATEGORIES ──────────────────────────────────────────────────────────
// Add a new category. Slug must be unique, lowercase, and use only
// letters/numbers/hyphens — it's what gets stored inside each print's
// categories JSONB array, so keeping it URL/filter-safe matters.
app.post('/api/admin/categories', requireAuth, async (req, res) => {
  const label = (req.body.label || '').trim();
  let slug = (req.body.slug || label).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const description = (req.body.description || '').trim() || null;
  if (!label) return res.status(400).json({ error: 'Label is required' });
  if (!slug) return res.status(400).json({ error: 'Could not derive a valid slug from that label' });
  try {
    const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories');
    const { rows } = await pool.query(
      'INSERT INTO categories (slug, label, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
      [slug, label, description, maxRows[0].m + 1]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: `A category with slug "${slug}" already exists` });
    res.status(500).json({ error: e.message });
  }
});

// NOTE: this literal-path route MUST stay registered before the '/:id' route
// below — Express matches top-down, so if '/:id' came first a PUT to
// '/reorder' would bind id="reorder" and never reach here (the same ordering
// the prints reorder/‌:id pair relies on).
app.put('/api/admin/categories/reorder', requireAuth, async (req, res) => {
  const { order } = req.body; // array of category IDs in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of IDs' });
  try {
    await Promise.all(order.map((id, i) =>
      pool.query('UPDATE categories SET sort_order=$1 WHERE id=$2', [i, id])
    ));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rename a category's label and/or slug. If the slug changes, every print
// currently tagged with the old slug is cascaded to the new one — both the
// categories JSONB array and the legacy single-value category column, so
// nothing silently goes stale.
app.put('/api/admin/categories/:id', requireAuth, async (req, res) => {
  const label = (req.body.label || '').trim();
  let slug = (req.body.slug || label).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const description = (req.body.description || '').trim() || null;
  if (!label) return res.status(400).json({ error: 'Label is required' });
  if (!slug) return res.status(400).json({ error: 'Could not derive a valid slug from that label' });
  try {
    const { rows: existing } = await pool.query('SELECT slug FROM categories WHERE id=$1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Category not found' });
    const oldSlug = existing[0].slug;

    const { rows } = await pool.query(
      'UPDATE categories SET slug=$1, label=$2, description=$3 WHERE id=$4 RETURNING *',
      [slug, label, description, req.params.id]
    );

    if (slug !== oldSlug) {
      // Cascade the rename across every print that references the old slug —
      // both the categories array (each matching element swapped) and the
      // legacy category column (which is always cats[0], see PUT /prints/:id).
      await pool.query(
        `UPDATE prints SET categories = (
           SELECT jsonb_agg(CASE WHEN elem = $1 THEN $2 ELSE elem END)
           FROM jsonb_array_elements_text(categories) AS elem
         ) WHERE categories @> to_jsonb($1::text)`,
        [oldSlug, slug]
      );
      await pool.query('UPDATE prints SET category=$1 WHERE category=$2', [slug, oldSlug]);
    }
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: `A category with slug "${slug}" already exists` });
    res.status(500).json({ error: e.message });
  }
});

// Remove a category — blocked if any print still references its slug, same
// safety pattern used for workshop dates with existing bookings: rather than
// silently untagging prints (which could leave one with zero categories) or
// orphaning references, the admin is told exactly how many prints use it and
// asked to re-tag them first.
app.delete('/api/admin/categories/:id', requireAuth, async (req, res) => {
  try {
    const { rows: existing } = await pool.query('SELECT slug, label FROM categories WHERE id=$1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Category not found' });
    const { slug, label } = existing[0];

    const { rows: usage } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM prints WHERE categories @> to_jsonb($1::text)',
      [slug]
    );
    if (usage[0].n > 0) {
      return res.status(400).json({
        error: `"${label}" is still used by ${usage[0].n} print${usage[0].n === 1 ? '' : 's'} — remove that tag from ${usage[0].n === 1 ? 'it' : 'them'} first.`
      });
    }
    await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── ADMIN SHOP ────────────────────────────────────────────────────────────────
// Get full shop settings for one print (sale status, edition, sizes, delivery)
// Public: personal delivery zones (for cart display)
app.get('/api/personal-delivery-zones', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT zone, label, price_chf_cents FROM personal_delivery_rates ORDER BY price_chf_cents ASC');
    res.json(rows.length ? rows : [
      { zone: 'canton_zurich', label: 'Canton of Zürich', price_chf_cents: 4000 },
      { zone: 'rest_of_switzerland', label: 'Rest of Switzerland', price_chf_cents: 7000 },
    ]);
  } catch (e) {
    res.json([
      { zone: 'canton_zurich', label: 'Canton of Zürich', price_chf_cents: 4000 },
      { zone: 'rest_of_switzerland', label: 'Rest of Switzerland', price_chf_cents: 7000 },
    ]);
  }
});

// ── ADMIN SHIPPING SETTINGS ──────────────────────────────────────────────────
app.get('/api/admin/shipping-settings', requireAuth, async (req, res) => {
  try {
    const { rows: settings } = await pool.query('SELECT key, value FROM shipping_settings ORDER BY key');
    const { rows: euRates } = await pool.query('SELECT * FROM eu_shipping_rates ORDER BY format, max_weight_g');
    const { rows: personalRates } = await pool.query('SELECT * FROM personal_delivery_rates ORDER BY price_chf_cents');
    res.json({ settings: Object.fromEntries(settings.map(r => [r.key, r.value])), euRates, personalRates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/shipping-settings', requireAuth, async (req, res) => {
  const { settings } = req.body;
  try {
    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        `INSERT INTO shipping_settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, String(value)]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/personal-delivery-rates', requireAuth, async (req, res) => {
  const { rates } = req.body; // [{zone, label, price_chf_cents}]
  try {
    for (const r of rates) {
      await pool.query(
        `UPDATE personal_delivery_rates SET label=$1, price_chf_cents=$2 WHERE zone=$3`,
        [r.label, parseInt(r.price_chf_cents), r.zone]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PAPERS ────────────────────────────────────────────────────────────────────
app.get('/api/admin/papers', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM papers ORDER BY name ASC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/papers', requireAuth, async (req, res) => {
  const { name, description, weight_gsm } = req.body;
  if (!name || !description) return res.status(400).json({ error: 'Name and description required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO papers (name, description, weight_gsm) VALUES ($1, $2, $3) RETURNING *',
      [name, description, weight_gsm ? parseInt(weight_gsm) : null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/papers/:id', requireAuth, async (req, res) => {
  const { name, description, weight_gsm } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE papers SET name=$1, description=$2, weight_gsm=$3 WHERE id=$4 RETURNING *',
      [name, description, weight_gsm ? parseInt(weight_gsm) : null, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/papers/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM papers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/shop/print/:id', requireAuth, async (req, res) => {
  try {
    const { rows: printRows } = await pool.query(
      `SELECT id, title, for_sale, edition_type, edition_size, delivery_ch, delivery_personal, delivery_intl, shop_note, paper_id, no_margin, lifestyle_image_url
       FROM prints WHERE id=$1`, [req.params.id]
    );
    if (!printRows[0]) return res.status(404).json({ error: 'Not found' });
    const { rows: sizes } = await pool.query(
      `SELECT id, size, price_chf, enabled, edition_sold FROM print_sizes WHERE print_id=$1 ORDER BY
       CASE size WHEN 'A4' THEN 1 WHEN 'A3' THEN 2 WHEN 'A2' THEN 3 ELSE 4 END`, [req.params.id]
    );
    res.json({ print: printRows[0], sizes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset edition sold counter for a specific print/size back to zero
app.post('/api/admin/shop/print/:id/reset-edition/:size', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE print_sizes SET edition_sold = 0 WHERE print_id=$1 AND size=$2',
      [req.params.id, req.params.size]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quick toggle for for_sale only — used by the checkbox in admin which auto-saves
// on change, since the full save button disappears when the print is unchecked
app.put('/api/admin/shop/print/:id/forsale', requireAuth, async (req, res) => {
  const { for_sale } = req.body;
  try {
    await pool.query('UPDATE prints SET for_sale=$1 WHERE id=$2', [!!for_sale, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update shop settings for a print (for_sale, edition info, delivery options, paper)
app.put('/api/admin/shop/print/:id', requireAuth, async (req, res) => {
  const { for_sale, edition_type, edition_size, delivery_ch, delivery_personal, delivery_intl, shop_note, paper_id, no_margin } = req.body;
  try {
    await pool.query(
      `UPDATE prints SET for_sale=$1, edition_type=$2, edition_size=$3,
       delivery_ch=$4, delivery_personal=$5, delivery_intl=$6, shop_note=$7, paper_id=$8, no_margin=$9 WHERE id=$10`,
      [!!for_sale, edition_type || 'open', edition_size || null, !!delivery_ch, !!delivery_personal, !!delivery_intl, shop_note || null, paper_id || null, !!no_margin, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upsert a size/price for a print (e.g. A4 -> CHF 80)
app.put('/api/admin/shop/print/:id/size', requireAuth, async (req, res) => {
  const { size, price_chf, enabled } = req.body;
  if (!['A4','A3','A2'].includes(size)) return res.status(400).json({ error: 'Invalid size' });
  try {
    await pool.query(
      `INSERT INTO print_sizes (print_id, size, price_chf, enabled)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (print_id, size) DO UPDATE SET price_chf=$3, enabled=$4`,
      [req.params.id, size, parseInt(price_chf) || 0, enabled !== false]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN SHIPPING RATES ─────────────────────────────────────────────────────
app.get('/api/admin/shipping-rates', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM shipping_rates ORDER BY delivery_method, size');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/shipping-rates', requireAuth, async (req, res) => {
  const { delivery_method, size, price_chf } = req.body;
  if (!['ch','personal','intl'].includes(delivery_method)) return res.status(400).json({ error: 'Invalid delivery method' });
  if (!['A4','A3','A2'].includes(size)) return res.status(400).json({ error: 'Invalid size' });
  try {
    await pool.query(
      `INSERT INTO shipping_rates (delivery_method, size, price_chf) VALUES ($1,$2,$3)
       ON CONFLICT (delivery_method, size) DO UPDATE SET price_chf=$3`,
      [delivery_method, size, parseInt(price_chf) || 0]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all orders, newest first
app.get('/api/admin/orders', requireAuth, async (req, res) => {
  try {
    // Show everything, including pending — stuck/pending orders usually mean
    // the Stripe webhook hasn't fired yet (or failed), and that should be visible
    // rather than silently hidden.
    const { rows: orders } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    const { rows: allItems } = await pool.query(
      `SELECT oi.*, p.image_url FROM order_items oi LEFT JOIN prints p ON p.id = oi.print_id`
    );
    const result = orders.map(o => ({
      ...o,
      items: allItems.filter(i => i.order_id === o.id),
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manually re-sync an order's status from Stripe — useful if the webhook
// never fired (e.g. wrong STRIPE_WEBHOOK_SECRET, endpoint URL typo, etc.)
app.post('/api/admin/orders/:id/sync', requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = rows[0];
    if (!order || !order.stripe_session_id) return res.status(404).json({ error: 'Order not found' });

    const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);

    let justClaimed = false;
    if (session.payment_status === 'paid' && order.status === 'pending') {
      // Same atomic claim as the webhook — protects against the race where the
      // webhook lands between our read of the order above and this update,
      // which would otherwise double-increment the edition counters.
      const { rows: claimed } = await pool.query(
        `UPDATE orders SET status='paid', stripe_payment_intent=$1, updated_at=NOW()
         WHERE id=$2 AND status='pending'
         RETURNING id`,
        [session.payment_intent, order.id]
      );
      if (claimed.length) {
        justClaimed = true;
        // Increment edition_sold counts, same as the webhook would
        const { rows: items } = await pool.query('SELECT print_id, size FROM order_items WHERE order_id=$1', [order.id]);
        for (const item of items) {
          await pool.query(
            `UPDATE print_sizes SET edition_sold = edition_sold + 1 WHERE print_id=$1 AND size=$2`,
            [item.print_id, item.size]
          );
        }
      }
    }

    // Backfill customer name/email/address whenever Stripe has it, regardless
    // of whether this order was already marked paid — this is what lets you
    // recover a missing address on an order you already confirmed.
    let addressFound = false;
    if (session.customer_details) {
      const addressToStore = (session.shipping_details && session.shipping_details.address) || session.customer_details.address || {};
      addressFound = Object.keys(addressToStore).length > 0;
      await pool.query(
        `UPDATE orders SET customer_name=$1, customer_email=$2, shipping_address=$3 WHERE id=$4`,
        [session.customer_details.name, session.customer_details.email, JSON.stringify(addressToStore), order.id]
      );
    }

    // If this sync (not the webhook) claimed the pending→paid transition, it
    // also owns sending the confirmation emails — done after the backfill above
    // so the customer email has name and shipping address populated.
    if (justClaimed) {
      try { await sendOrderConfirmationEmails(order.stripe_session_id); }
      catch (e) { console.error('Sync confirmation emails failed:', e); }
    }

    res.json({
      ok: true,
      status: order.status === 'pending' && session.payment_status === 'paid' ? 'paid' : order.status,
      stripe_payment_status: session.payment_status,
      address_found: addressFound,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update order status (e.g. mark as fulfilled/shipped)
app.put('/api/admin/orders/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!['paid','fulfilled','cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await pool.query('UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Permanently wipe every order and its line items. Destructive and irreversible
// — the frontend gates this behind a typed confirmation challenge before it
// ever calls this route, but the route itself has no extra protection beyond
// requireAuth, so treat the admin password as the real safeguard here.
app.delete('/api/admin/orders/clear-all', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM order_items');
    await pool.query('DELETE FROM orders');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update one item in the fulfilment checklist (e.g. {"printed": true})
app.put('/api/admin/orders/:id/checklist', requireAuth, async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const { rows } = await pool.query('SELECT fulfilment_checklist FROM orders WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    const checklist = rows[0].fulfilment_checklist || {};
    checklist[key] = !!value;
    await pool.query('UPDATE orders SET fulfilment_checklist=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(checklist), req.params.id]);
    res.json({ ok: true, checklist });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save your own private notes on an order — never shown to the customer
app.put('/api/admin/orders/:id/notes', requireAuth, async (req, res) => {
  const { notes } = req.body;
  try {
    await pool.query('UPDATE orders SET notes=$1, updated_at=NOW() WHERE id=$2', [notes || '', req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send the customer a "your print has shipped" email — call manually from admin
app.post('/api/admin/orders/:id/notify-shipped', requireAuth, async (req, res) => {
  if (!resend) return res.status(500).json({ error: 'Email is not configured (RESEND_API_KEY missing)' });
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.customer_email) return res.status(400).json({ error: 'No customer email on file for this order' });

    const { rows: items } = await pool.query(
      `SELECT oi.print_title, oi.size, p.image_url FROM order_items oi LEFT JOIN prints p ON p.id = oi.print_id WHERE oi.order_id=$1`,
      [order.id]
    );
    const itemsHtml = items.map(i => `
      <tr>
        <td style="padding:10px 0;width:68px"><table cellpadding="0" cellspacing="0" style="width:64px;height:64px"><tr><td align="center" valign="middle">${i.image_url ? `<img src="${i.image_url}" alt="" style="max-width:64px;max-height:64px;border-radius:4px;display:block">` : ''}</td></tr></table></td>
        <td style="padding:10px 0 10px 14px;font-size:14px;color:#1A1714">${i.print_title}<span style="color:#8A8680">, ${i.size}</span></td>
      </tr>
    `).join('');

    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'noreply@bharatbhatia.photography',
      to: order.customer_email,
      reply_to: REPLY_TO_EMAIL,
      subject: 'Your print is on its way',
      html: emailShell(`
        <h2 style="font-family:Georgia,serif;font-style:italic;font-size:22px;margin:0 0 8px;color:#1A1714">On its way.</h2>
        <p style="font-size:14px;color:#3D3731;line-height:1.7;margin:0 0 22px">Hi ${order.customer_name ? order.customer_name.split(' ')[0] : 'there'}, good news, your print${items.length > 1 ? 's are' : ' is'} on the way.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border-top:1px solid #EFEFEC;border-bottom:1px solid #EFEFEC">${itemsHtml}</table>
        <p style="margin:0 0 22px;font-size:13px;color:#8A8680"><strong style="color:#1A1714">Delivery:</strong> ${DELIVERY_LABELS[order.delivery_method] || order.delivery_method}</p>
        <p style="font-size:13px;color:#8A8680;line-height:1.7;margin:0 0 12px">Thanks for supporting the work. I hope you enjoy living with it.</p>
        <p style="font-size:13px;color:#8A8680;line-height:1.7;margin:0">Any questions? Email ${REPLY_TO_EMAIL} and it'll reach me directly.</p>
      `),
    });

    // Mark the checklist item automatically since we just did it
    const checklist = order.fulfilment_checklist || {};
    checklist.shipping_email_sent = true;
    await pool.query('UPDATE orders SET fulfilment_checklist=$1 WHERE id=$2', [JSON.stringify(checklist), order.id]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SEO: server-rendered per-route meta tags + JSON-LD ───────────────────────
// The site is a client-rendered SPA, so without this, every route would serve
// the homepage's meta tags and crawlers/link-previews would see no page-specific
// content. We read index.html once, then inject route-appropriate <title>,
// description, Open Graph tags, canonical, and JSON-LD structured data before
// sending. Focus: the artist and their prints for sale.
const fs = require('fs');
const SITE = 'https://bharatbhatia.photography';
const DEFAULT_OG_IMAGE = 'https://res.cloudinary.com/dqsl63ax7/image/upload/v1777886744/baji-prints/zazpsby8txguspgnfhis.jpg';
let _indexHtmlCache = null;
function indexHtml() {
  if (!_indexHtmlCache) {
    _indexHtmlCache = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  }
  return _indexHtmlCache;
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
// Base JSON-LD: the artist as a Person, plus the site. Present on every page.
function personJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    "name": "Bharat Bhatia",
    "alternateName": "Baji",
    "jobTitle": "Fine Art Photographer",
    "url": SITE,
    "image": DEFAULT_OG_IMAGE,
    "sameAs": ["https://instagram.com/bajidigital"],
    "address": { "@type": "PostalAddress", "addressLocality": "Zürich", "addressCountry": "CH" },
    "knowsAbout": ["Fine art photography", "Giclée printing", "Abstract photography", "Intentional camera movement", "Macro photography"]
  };
}
// Serves index.html with injected meta for a given route.
function serveWithMeta(res, { title, description, path: urlPath, image, jsonLd }) {
  let html = indexHtml();
  const canonical = SITE + (urlPath || '/');
  const img = image || DEFAULT_OG_IMAGE;
  const desc = escapeHtml(description);
  const t = escapeHtml(title);

  html = html
    .replace(/<title id="meta-title">[^<]*<\/title>/,
      `<title id="meta-title">${t}</title>`)
    .replace(/(<meta name="description" id="meta-desc" content=")[^"]*(">)/,
      `$1${desc}$2`)
    .replace(/(<meta property="og:title" id="meta-og-title" content=")[^"]*(">)/,
      `$1${t}$2`)
    .replace(/(<meta property="og:description" id="meta-og-desc" content=")[^"]*(">)/,
      `$1${desc}$2`)
    .replace(/(<meta property="og:image" id="meta-og-image" content=")[^"]*(">)/,
      `$1${escapeHtml(img)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(">)/,
      `$1${escapeHtml(canonical)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(">)/,
      `$1${escapeHtml(canonical)}$2`);

  // Inject JSON-LD (Person + optional page-specific) right before </head>.
  const blocks = [personJsonLd()];
  if (jsonLd) blocks.push(jsonLd);
  const ld = blocks.map(b =>
    `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('\n');
  html = html.replace('</head>', `${ld}\n</head>`);

  res.type('html').send(html);
}

// Per-route metadata (art / prints focused).
const ROUTE_META = {
  '/': {
    title: 'Bharat Bhatia — Fine Art Photography & Prints, Zürich',
    description: 'Limited edition fine art photography prints by Bharat Bhatia — abstract, black-and-white and macro work, hand-printed in Zürich on museum-grade archival paper.',
  },
  '/shop': {
    title: 'Fine Art Prints for Sale — Bharat Bhatia, Zürich',
    description: 'Buy limited edition and open edition fine art photography prints. Abstract and black-and-white work, hand-printed in Zürich on archival museum-grade paper, shipped worldwide.',
  },
  '/workshops': {
    title: 'Photography Workshops — Bharat Bhatia, Zürich',
    description: 'A full-day photo-to-print workshop in Zürich: shoot fine art photography and leave with a large-format archival print made in the artist\'s own atelier.',
  },
  '/about': {
    title: 'About — Bharat Bhatia, Fine Art Photographer, Zürich',
    description: 'Bharat Bhatia is a Zürich-based fine art photographer working in abstract, black-and-white and macro imagery, printing each piece by hand in his atelier.',
  },
  '/contact': {
    title: 'Contact — Bharat Bhatia, Fine Art Photography, Zürich',
    description: 'Get in touch about fine art prints, commissions, or giclée printing in Zürich.',
  },
  '/faq': {
    title: 'FAQ — Bharat Bhatia Fine Art Prints, Zürich',
    description: 'Answers about paper, sizes, editions, shipping, personal delivery and workshops for Bharat Bhatia fine art photography prints.',
  },
};

// Static routes with their own meta.
app.get('/', (req, res) => serveWithMeta(res, { ...ROUTE_META['/'], path: '/' }));
app.get('/workshops', (req, res) => serveWithMeta(res, { ...ROUTE_META['/workshops'], path: '/workshops' }));
app.get('/shop', (req, res) => serveWithMeta(res, { ...ROUTE_META['/shop'], path: '/shop' }));
app.get('/cart', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
for (const p of ['/about', '/contact', '/faq']) {
  app.get(p, (req, res) => serveWithMeta(res, { ...ROUTE_META[p], path: p }));
}
for (const p of ['/impressum', '/privacy', '/terms']) {
  app.get(p, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
}

// Per-product page: /shop/:id — pulls the print so the title, description, image
// and Product JSON-LD are specific to that print (key for sharing + rich results).
app.get('/shop/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return serveWithMeta(res, { ...ROUTE_META['/shop'], path: '/shop' });
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.description, p.image_url, p.edition_type,
              MIN(ps.price_chf) AS min_price
       FROM prints p
       LEFT JOIN print_sizes ps ON ps.print_id = p.id AND ps.enabled = TRUE
       WHERE p.id = $1 AND p.for_sale = TRUE
       GROUP BY p.id`, [id]
    );
    const p = rows[0];
    if (!p) return serveWithMeta(res, { ...ROUTE_META['/shop'], path: '/shop' });

    const title = `${p.title} — Fine Art Print by Bharat Bhatia`;
    const description = p.description
      ? `${p.description} Limited ${p.edition_type === 'limited' ? 'edition' : 'open edition'} fine art print, hand-printed in Zürich on archival paper.`.slice(0, 300)
      : `${p.title} — a fine art photography print by Bharat Bhatia, hand-printed in Zürich on museum-grade archival paper.`;
    const image = p.image_url || DEFAULT_OG_IMAGE;

    const productLd = {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": p.title,
      "image": image,
      "description": p.description || `${p.title} — fine art photography print by Bharat Bhatia.`,
      "brand": { "@type": "Brand", "name": "Bharat Bhatia" },
      "category": "Fine Art Photography Print",
    };
    if (p.min_price) {
      productLd.offers = {
        "@type": "Offer",
        "priceCurrency": "CHF",
        "price": (p.min_price / 100).toFixed(2),
        "availability": "https://schema.org/InStock",
        "url": `${SITE}/shop/${p.id}`,
      };
    }
    serveWithMeta(res, { title, description, path: `/shop/${p.id}`, image, jsonLd: productLd });
  } catch (e) {
    serveWithMeta(res, { ...ROUTE_META['/shop'], path: '/shop' });
  }
});
app.get('/shop/*', (req, res) => serveWithMeta(res, { ...ROUTE_META['/shop'], path: '/shop' }));



// Public: upcoming open dates with live remaining capacity. A spot is taken by
// a paid booking, or by a pending one younger than 35 minutes (the lifetime of
// its Stripe Checkout session) — so two people can't both buy the last spot,
// but an abandoned checkout releases its hold automatically.
app.get('/api/workshops', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT wd.id, wd.date, wd.capacity, wd.price_chf_cents, wd.frame_price_chf_cents,
        COUNT(wb.id) FILTER (WHERE wb.status = 'paid') AS paid_count,
        COUNT(wb.id) FILTER (WHERE wb.status = 'pending' AND wb.created_at > NOW() - INTERVAL '35 minutes') AS pending_count
      FROM workshop_dates wd
      LEFT JOIN workshop_bookings wb ON wb.workshop_date_id = wd.id
      WHERE wd.status = 'open' AND wd.date >= CURRENT_DATE
      GROUP BY wd.id
      ORDER BY wd.date ASC
    `);
    res.json(rows.map(r => ({
      id: r.id,
      date: r.date,
      capacity: r.capacity,
      price_chf_cents: r.price_chf_cents,
      frame_price_chf_cents: r.frame_price_chf_cents,
      spots_left: Math.max(0, r.capacity - parseInt(r.paid_count) - parseInt(r.pending_count)),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public: workshop gallery photos
app.get('/api/workshop-photos', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, image_url FROM workshop_photos ORDER BY sort_order ASC, id ASC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: all dates (any status) with booking counts
app.get('/api/admin/workshop-dates', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT wd.*,
        COUNT(wb.id) FILTER (WHERE wb.status = 'paid') AS paid_count,
        COUNT(wb.id) FILTER (WHERE wb.status = 'pending' AND wb.created_at > NOW() - INTERVAL '35 minutes') AS pending_count
      FROM workshop_dates wd
      LEFT JOIN workshop_bookings wb ON wb.workshop_date_id = wd.id
      GROUP BY wd.id
      ORDER BY wd.date DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/workshop-dates', requireAuth, async (req, res) => {
  try {
    const { date, capacity, price_chf_cents, frame_price_chf_cents, status } = req.body;
    if (!date) return res.status(400).json({ error: 'Date is required' });
    const { rows } = await pool.query(
      `INSERT INTO workshop_dates (date, capacity, price_chf_cents, frame_price_chf_cents, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [date, capacity || 6, price_chf_cents || 30000, frame_price_chf_cents || null, status || 'draft']
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/workshop-dates/:id', requireAuth, async (req, res) => {
  try {
    const { date, capacity, price_chf_cents, frame_price_chf_cents, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE workshop_dates SET
         date = COALESCE($1, date),
         capacity = COALESCE($2, capacity),
         price_chf_cents = COALESCE($3, price_chf_cents),
         frame_price_chf_cents = $4,
         status = COALESCE($5, status)
       WHERE id = $6 RETURNING *`,
      [date || null, capacity || null, price_chf_cents || null, frame_price_chf_cents ?? null, status || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a date — only allowed while it has no bookings at all, so a date with
// paying customers can never vanish. Close it instead (status = 'closed').
app.delete('/api/admin/workshop-dates/:id', requireAuth, async (req, res) => {
  try {
    const { rows: bookings } = await pool.query(
      'SELECT COUNT(*) FROM workshop_bookings WHERE workshop_date_id = $1', [req.params.id]
    );
    if (parseInt(bookings[0].count) > 0) {
      return res.status(400).json({ error: 'This date has bookings — set it to closed instead of deleting.' });
    }
    await pool.query('DELETE FROM workshop_dates WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: bookings for one date (who's coming, contact, frame, dietary)
app.get('/api/admin/workshop-bookings', requireAuth, async (req, res) => {
  try {
    const { date_id } = req.query;
    if (!date_id) return res.status(400).json({ error: 'date_id required' });
    const { rows } = await pool.query(
      `SELECT * FROM workshop_bookings WHERE workshop_date_id = $1 ORDER BY created_at ASC`,
      [date_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: gallery management
app.post('/api/admin/workshop-photos', requireAuth, workshopUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS max FROM workshop_photos');
    const { rows } = await pool.query(
      'INSERT INTO workshop_photos (image_url, public_id, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [req.file.path, req.file.filename, maxRows[0].max + 1]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/workshop-photos/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM workshop_photos WHERE id = $1 RETURNING public_id', [req.params.id]);
    if (rows[0] && rows[0].public_id) {
      try { await cloudinary.uploader.destroy(rows[0].public_id); } catch (e) { /* orphan in Cloudinary is acceptable */ }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/workshop-photos/reorder', requireAuth, async (req, res) => {
  try {
    const { order } = req.body; // array of photo ids in desired order
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    for (let i = 0; i < order.length; i++) {
      await pool.query('UPDATE workshop_photos SET sort_order = $1 WHERE id = $2', [i, order[i]]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Track visits to the main site (not admin, not API)
// Throttle the public tracking endpoints: 120 hits per minute per IP, shared
// across both routes. A real visitor loading pages and clicking through prints
// never approaches this; it just caps someone scripting fake views. These are
// fire-and-forget calls (the frontend ignores the response), so a 429 here has
// zero effect on the visitor's experience.
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false },
});

app.post('/api/pageview', trackLimiter, async (req, res) => {
  try {
    const { path, referrer } = req.body;
    await pool.query(
      'INSERT INTO pageviews (path, referrer) VALUES ($1, $2)',
      [path || '/', referrer || null]
    );
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.post('/api/photoview', trackLimiter, async (req, res) => {
  try {
    const { print_id } = req.body;
    if (!print_id) return res.json({ ok: false });
    await pool.query('INSERT INTO photo_views (print_id) VALUES ($1)', [print_id]);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.get('/api/admin/stats', requireAuth, async (req, res) => {
  try {
    const total  = await pool.query('SELECT COUNT(*) FROM pageviews');
    const today  = await pool.query("SELECT COUNT(*) FROM pageviews WHERE visited_at > NOW() - INTERVAL '1 day'");
    const week   = await pool.query("SELECT COUNT(*) FROM pageviews WHERE visited_at > NOW() - INTERVAL '7 days'");
    const month  = await pool.query("SELECT COUNT(*) FROM pageviews WHERE visited_at > NOW() - INTERVAL '30 days'");
    const daily  = await pool.query(`
      SELECT DATE(visited_at) as day, COUNT(*) as count
      FROM pageviews WHERE visited_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(visited_at) ORDER BY day ASC
    `);
    const referrers = await pool.query(
      "SELECT CASE" +
      " WHEN referrer IS NULL OR referrer = '' THEN 'Direct'" +
      " WHEN referrer ILIKE '%instagram%' THEN 'Instagram'" +
      " WHEN referrer ILIKE '%google%' THEN 'Google'" +
      " WHEN referrer ILIKE '%facebook%' THEN 'Facebook'" +
      " WHEN referrer ILIKE '%linkedin%' THEN 'LinkedIn'" +
      " WHEN referrer ILIKE '%twitter%' OR referrer ILIKE '%x.com%' THEN 'Twitter/X'" +
      " WHEN referrer ILIKE '%whatsapp%' THEN 'WhatsApp'" +
      " ELSE regexp_replace(referrer, '^https?://([^/]+).*', " + "'\\1')" +
      " END as source, COUNT(*) as count" +
      " FROM pageviews WHERE visited_at > NOW() - INTERVAL '30 days'" +
      " GROUP BY source ORDER BY count DESC LIMIT 8"
    );
    const topPhotos = await pool.query(`
      SELECT p.id, p.title, p.image_url, COUNT(pv.id) as views
      FROM prints p
      LEFT JOIN photo_views pv ON pv.print_id = p.id
      GROUP BY p.id, p.title, p.image_url
      ORDER BY views DESC LIMIT 5
    `);
    res.json({
      total:     parseInt(total.rows[0].count),
      today:     parseInt(today.rows[0].count),
      week:      parseInt(week.rows[0].count),
      month:     parseInt(month.rows[0].count),
      daily:     daily.rows,
      referrers: referrers.rows,
      topPhotos: topPhotos.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Wipe all visit/photo-view tracking data — irreversible. Used to start
// stats over from zero, e.g. after testing or before a real launch.
app.post('/api/admin/stats/reset', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM pageviews');
    await pool.query('DELETE FROM photo_views');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SEO FILES ─────────────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  // /client/* are private password-protected proofing boards — keep them out
  // of every index (the X-Robots-Tag header on those routes backs this up).
  res.send('User-agent: *\nAllow: /\nDisallow: /client/\nSitemap: https://bharatbhatia.photography/sitemap.xml');
});

app.get('/sitemap.xml', async (req, res) => {
  const base = 'https://bharatbhatia.photography';
  res.type('application/xml');
  // Static routes + every for-sale print (so Google can discover each one).
  const staticUrls = [
    { loc: '/',          freq: 'weekly',  pri: '1.0' },
    { loc: '/shop',      freq: 'weekly',  pri: '0.9' },
    { loc: '/workshops', freq: 'monthly', pri: '0.6' },
    { loc: '/about',     freq: 'monthly', pri: '0.5' },
    { loc: '/contact',   freq: 'yearly',  pri: '0.4' },
    { loc: '/faq',       freq: 'monthly', pri: '0.4' },
  ];
  let productUrls = [];
  try {
    const { rows } = await pool.query(
      "SELECT id FROM prints WHERE for_sale = TRUE ORDER BY sort_order ASC"
    );
    productUrls = rows.map(r => ({ loc: `/shop/${r.id}`, freq: 'weekly', pri: '0.8' }));
  } catch (e) { /* fall back to static-only sitemap */ }
  const all = [...staticUrls, ...productUrls];
  const body = all.map(u =>
    `  <url><loc>${base}${u.loc}</loc><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`
  ).join('\n');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`);
});

// ── MESSAGES ──────────────────────────────────────────────────────────────────
app.get('/api/admin/messages', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM messages ORDER BY created_at DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/messages/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE messages SET read=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/messages/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM messages WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SERVE FRONTEND ────────────────────────────────────────────────────────────
// ── CLIENT PROOFING BOARDS ────────────────────────────────────────────────────
// Private per-client review boards at /client/<slug>. Not linked from the site,
// excluded from robots.txt and the sitemap, and served with noindex headers.

// Same shape as the admin login limiter — slow down password guessing on a
// board URL, which is the only thing standing between a guesser and the images.
const clientLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.' },
});

app.post('/api/client/:slug/login', clientLoginLimiter, async (req, res) => {
  try {
    const client = await getClient(req.params.slug);
    // Same generic response whether the board or the password is wrong, so the
    // endpoint can't be used to enumerate which client slugs exist.
    if (!client || !client.password_hash) return res.status(401).json({ error: 'Falsches Passwort' });
    const ok = await bcrypt.compare(String(req.body.password || ''), client.password_hash);
    if (!ok) return res.status(401).json({ error: 'Falsches Passwort' });
    req.session.client_slug = client.slug;
    req.session.client_id = client.id;
    res.json({ ok: true, name: client.name });
  } catch (e) {
    console.error('Client login error:', e);
    res.status(500).json({ error: 'Login fehlgeschlagen' });
  }
});

app.post('/api/client/:slug/logout', (req, res) => {
  // Only drop the client role — never touch req.session.admin, so logging a
  // client out on a shared browser doesn't log the admin out too.
  delete req.session.client_slug;
  delete req.session.client_id;
  res.json({ ok: true });
});

app.get('/api/client/:slug/session', async (req, res) => {
  const client = await getClient(req.params.slug);
  const authed = !!req.session.admin || (client && req.session.client_slug === client.slug);
  // Deliberately identical response for an unknown slug and a locked board, and
  // the client's name is withheld until authenticated — otherwise anyone who
  // guessed a URL could confirm the board exists and learn whose it is.
  if (!client || !authed) {
    return res.json({ admin: false, client: false, name: null });
  }
  res.json({
    admin: !!req.session.admin,
    client: req.session.client_slug === client.slug,
    name: client.name,
  });
});

// The whole board in one call — rooms → spots → photos. Small enough (one
// practice's worth of photos) that paginating would be premature.
app.get('/api/client/:slug/board', requireBoardAccess, async (req, res) => {
  try {
    const client = await getClient(req.params.slug);
    if (!client) return res.status(404).json({ error: 'Not found' });
    const { rows: rooms } = await pool.query(
      'SELECT id, name, note, sort_order FROM client_rooms WHERE client_id=$1 ORDER BY sort_order, id', [client.id]
    );
    const { rows: spots } = await pool.query(
      `SELECT s.id, s.room_id, s.name, s.note, s.sort_order FROM client_spots s
         JOIN client_rooms r ON r.id = s.room_id
        WHERE r.client_id=$1 ORDER BY s.sort_order, s.id`, [client.id]
    );
    const { rows: photos } = await pool.query(
      `SELECT p.id, p.spot_id, p.image_url, p.note, p.series, p.original_name, p.public_id,
              p.width, p.height, p.status, p.client_comment,
              p.reacted_at, p.seen_by_admin, p.sort_order
         FROM client_photos p
         JOIN client_spots s ON s.id = p.spot_id
         JOIN client_rooms r ON r.id = s.room_id
        WHERE r.client_id=$1 ORDER BY p.sort_order, p.id`, [client.id]
    );
    // The filename a photo was uploaded under is a working aid for the
    // photographer — it can carry a shoot name, a version, a client's surname.
    // It leaves the payload entirely for the client rather than being hidden in
    // the page, so the board's JSON gives nothing away either.
    const isAdmin = !!req.session.admin;
    const visible = isAdmin ? photos : photos.map(({ original_name, public_id, ...rest }) => rest);

    const byRoom = rooms.map(r => ({
      ...r,
      spots: spots.filter(s => s.room_id === r.id).map(s => ({
        ...s,
        photos: visible.filter(p => p.spot_id === s.id),
      })),
    }));
    res.json({
      client: { slug: client.slug, name: client.name, eyebrow: client.eyebrow, intro: client.intro },
      isAdmin,
      rooms: byRoom,
    });
  } catch (e) {
    console.error('Board load error:', e);
    res.status(500).json({ error: e.message });
  }
});

// The client's reaction. Approve/decline/comment are independent per photo —
// approving one candidate never changes the others in the same spot.
app.put('/api/client/photo/:id/react', async (req, res) => {
  try {
    const client = await clientForPhoto(req.params.id);
    if (!client) return res.status(404).json({ error: 'Not found' });
    const isClient = req.session.client_slug === client.slug;
    if (!isClient && !req.session.admin) return res.status(401).json({ error: 'Unauthorised' });

    const status = ['approved', 'declined', 'pending'].includes(req.body.status) ? req.body.status : 'pending';
    const comment = (req.body.comment || '').trim().slice(0, 2000) || null;
    // seen_by_admin resets to false on every client reaction so a revised
    // opinion resurfaces in the admin badge; an admin edit doesn't.
    const { rows } = await pool.query(
      `UPDATE client_photos
          SET status=$1, client_comment=$2, reacted_at=NOW(), seen_by_admin=$3
        WHERE id=$4
        RETURNING id, status, client_comment, reacted_at, seen_by_admin`,
      [status, comment, !isClient, req.params.id]
    );
    res.json(rows[0]);

    // Notify by email, but only for a real client reaction, and never let a
    // mail failure fail the request the client is waiting on.
    if (isClient && resend) {
      const { rows: ctx } = await pool.query(
        `SELECT s.name AS spot, r.name AS room, p.series, p.original_name FROM client_photos p
           JOIN client_spots s ON s.id = p.spot_id
           JOIN client_rooms r ON r.id = s.room_id
          WHERE p.id = $1`, [req.params.id]
      );
      // Addressed to the photographer, so it's in English even though the board
      // itself is German. The client's own comment is quoted verbatim.
      // A room with no spots of its own has an unnamed spot — name the room alone.
      // The series is appended when the photo carries one: with two or three in
      // play, "approved" says little without it.
      const where = ctx[0]
        ? (ctx[0].spot ? `${ctx[0].room} · ${ctx[0].spot}` : ctx[0].room) +
          (ctx[0].series ? ` (${ctx[0].series})` : '')
        : 'Unknown spot';
      const label = status === 'approved' ? '✓ Approved' : status === 'declined' ? '✗ Declined' : '– Cleared';
      resend.emails.send({
        from: process.env.EMAIL_FROM || 'noreply@bharatbhatia.photography',
        to: CLIENT_NOTIFY_EMAIL,
        reply_to: CLIENT_NOTIFY_EMAIL,
        subject: `${client.name}: ${label} — ${where}`,
        html: emailShell(
          `<p style="margin:0 0 12px;font-size:15px;color:#1A1714"><strong>${esc(client.name)}</strong> responded.</p>
           <p style="margin:0 0 6px;font-size:14px;color:#4A453E">${esc(where)}</p>
           <p style="margin:0 0 12px;font-size:15px;color:#1A1714">${esc(label)}</p>
           ${ctx[0] && ctx[0].original_name ? `<p style="margin:0 0 12px;font-size:13px;color:#8A857C">${esc(ctx[0].original_name)}</p>` : ''}
           ${comment ? `<p style="margin:0 0 12px;padding:12px;background:#F7F5F1;border-radius:4px;font-size:14px;color:#1A1714">${esc(comment)}</p>` : ''}
           <p style="margin:16px 0 0;font-size:13px;color:#8A857C">${SITE}/client/${esc(client.slug)}</p>`
        ),
      }).catch(e => console.error('Client reaction email failed (non-fatal):', e.message));
    }
  } catch (e) {
    console.error('Reaction save error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT BOARD ADMIN ────────────────────────────────────────────────────────
// Management lives on the client page itself: open /client/<slug> while logged
// in as admin and these back the inline controls.

app.get('/api/admin/clients', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.slug, c.name, (c.password_hash IS NOT NULL) AS has_password,
            (SELECT COUNT(*)::int FROM client_photos p
               JOIN client_spots s ON s.id=p.spot_id
               JOIN client_rooms r ON r.id=s.room_id
              WHERE r.client_id=c.id AND p.reacted_at IS NOT NULL AND p.seen_by_admin=FALSE) AS unseen
       FROM clients c ORDER BY c.name`
  );
  res.json(rows);
});

// Header text: name is required (COALESCE keeps the old one if blank), while
// eyebrow and intro are nullable — clearing them falls back to the defaults.
app.put('/api/admin/clients/:slug', requireAuth, async (req, res) => {
  const { name, eyebrow, intro } = req.body;
  const clean = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const { rows } = await pool.query(
    `UPDATE clients SET name=COALESCE($1,name), eyebrow=$2, intro=$3
      WHERE slug=$4 RETURNING slug, name, eyebrow, intro`,
    [clean(name), clean(eyebrow), clean(intro), req.params.slug]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.put('/api/admin/clients/:slug/password', requireAuth, async (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const hash = await bcrypt.hash(pw, 10);
  const { rows } = await pool.query(
    'UPDATE clients SET password_hash=$1 WHERE slug=$2 RETURNING slug', [hash, req.params.slug]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Clears every unseen flag on the board — the "mark all read" action.
app.post('/api/admin/clients/:slug/mark-seen', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE client_photos SET seen_by_admin=TRUE
      WHERE spot_id IN (SELECT s.id FROM client_spots s
                          JOIN client_rooms r ON r.id=s.room_id
                          JOIN clients c ON c.id=r.client_id
                         WHERE c.slug=$1)`, [req.params.slug]
  );
  res.json({ ok: true });
});

app.post('/api/admin/clients/:slug/rooms', requireAuth, async (req, res) => {
  const client = await getClient(req.params.slug);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const { rows } = await pool.query(
    `INSERT INTO client_rooms (client_id, name, note, sort_order)
     VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort_order),0)+1 FROM client_rooms WHERE client_id=$1))
     RETURNING id, name, note, sort_order`,
    [client.id, (req.body.name || 'New room').trim(), req.body.note || null]
  );
  res.json({ ...rows[0], spots: [] });
});

// Literal path before the /:id routes below — Express matches in order.
app.put('/api/admin/client-rooms/reorder', requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  for (let i = 0; i < ids.length; i++) {
    await pool.query('UPDATE client_rooms SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
  }
  res.json({ ok: true });
});

app.put('/api/admin/client-rooms/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE client_rooms SET name=$1, note=$2 WHERE id=$3 RETURNING id, name, note',
    [(req.body.name || '').trim(), (req.body.note || '').trim() || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.delete('/api/admin/client-rooms/:id', requireAuth, async (req, res) => {
  try {
    // Collect Cloudinary ids before the cascade removes the rows, otherwise the
    // assets are orphaned in the media library with no way back to them.
    const { rows: doomed } = await pool.query(
      `SELECT p.public_id FROM client_photos p
         JOIN client_spots s ON s.id=p.spot_id
        WHERE s.room_id=$1 AND p.public_id IS NOT NULL`, [req.params.id]
    );
    await pool.query('DELETE FROM client_rooms WHERE id=$1', [req.params.id]);
    doomed.forEach(d => cloudinary.uploader.destroy(d.public_id)
      .catch(e => console.error('Client photo cleanup failed (non-fatal):', e.message)));
    res.json({ ok: true, removed_images: doomed.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A blank name is meaningful, not missing: a room with only one obvious place
// for a picture gets a single unnamed spot, and the board hangs its photos
// straight off the room heading with no spot header. Only an ABSENT name falls
// back to the placeholder.
app.post('/api/admin/client-rooms/:id/spots', requireAuth, async (req, res) => {
  const name = req.body.name == null ? 'New spot' : String(req.body.name).trim();
  const { rows } = await pool.query(
    `INSERT INTO client_spots (room_id, name, note, sort_order)
     VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort_order),0)+1 FROM client_spots WHERE room_id=$1))
     RETURNING id, room_id, name, note, sort_order`,
    [req.params.id, name, req.body.note || null]
  );
  res.json({ ...rows[0], photos: [] });
});

app.put('/api/admin/client-spots/reorder', requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  for (let i = 0; i < ids.length; i++) {
    await pool.query('UPDATE client_spots SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
  }
  res.json({ ok: true });
});

app.put('/api/admin/client-spots/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE client_spots SET name=$1, note=$2 WHERE id=$3 RETURNING id, name, note',
    [(req.body.name || '').trim(), req.body.note || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.delete('/api/admin/client-spots/:id', requireAuth, async (req, res) => {
  try {
    const { rows: doomed } = await pool.query(
      'SELECT public_id FROM client_photos WHERE spot_id=$1 AND public_id IS NOT NULL', [req.params.id]
    );
    await pool.query('DELETE FROM client_spots WHERE id=$1', [req.params.id]);
    doomed.forEach(d => cloudinary.uploader.destroy(d.public_id)
      .catch(e => console.error('Client photo cleanup failed (non-fatal):', e.message)));
    res.json({ ok: true, removed_images: doomed.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload candidate photos. Two entry points — one spot, or a whole room that
// needs no spots at all — sharing the multer stage and the insert below. The
// client slug is resolved BEFORE multer runs so clientStorage can route the
// file into that client's folder.
const resolveSpotUpload = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.slug FROM client_spots s
         JOIN client_rooms r ON r.id=s.room_id
         JOIN clients c ON c.id=r.client_id
        WHERE s.id=$1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Spot not found' });
    req.uploadClientSlug = rows[0].slug;
    req.uploadSpotId = Number(req.params.id);
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// Room-level upload: the photos land in the room's unnamed spot, which is
// created lazily AFTER the files are in (see the insert stage) so a failed
// upload never leaves an empty spot behind on the client's board.
const resolveRoomUpload = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.slug FROM client_rooms r
         JOIN clients c ON c.id=r.client_id
        WHERE r.id=$1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Room not found' });
    req.uploadClientSlug = rows[0].slug;
    req.uploadRoomId = Number(req.params.id);
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

const runClientUpload = (req, res, next) => {
  clientUpload.array('photos', 20)(req, res, (err) => {
    if (err) {
      console.error('Client photo upload error:', err);
      return res.status(500).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
};

// The room's unnamed spot, created on first use. Reused on every later upload so
// a room never collects a pile of blank spots.
async function roomDefaultSpot(roomId) {
  const { rows } = await pool.query(
    `SELECT id FROM client_spots WHERE room_id=$1 AND COALESCE(name,'')=''
      ORDER BY sort_order, id LIMIT 1`, [roomId]
  );
  if (rows[0]) return rows[0].id;
  const { rows: made } = await pool.query(
    `INSERT INTO client_spots (room_id, name, sort_order)
     VALUES ($1,'',(SELECT COALESCE(MAX(sort_order),0)+1 FROM client_spots WHERE room_id=$1))
     RETURNING id`, [roomId]
  );
  return made[0].id;
}

const saveClientPhotos = async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files received' });
    const spotId = req.uploadSpotId || await roomDefaultSpot(req.uploadRoomId);
    // One series tag for the whole batch — an upload is normally one series'
    // worth of candidates. multer has parsed the text fields by now.
    const series = (req.body.series || '').trim().slice(0, 80) || null;
    const created = [];
    for (const f of req.files) {
      const { rows } = await pool.query(
        `INSERT INTO client_photos (spot_id, image_url, public_id, width, height, series, original_name, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(sort_order),0)+1 FROM client_photos WHERE spot_id=$1))
         RETURNING id, spot_id, image_url, note, series, original_name, width, height, status, client_comment, reacted_at, seen_by_admin, sort_order`,
        [spotId, f.path, f.filename, f.width || null, f.height || null, series,
         (f.originalname || '').slice(0, 260) || null]
      );
      created.push(rows[0]);
    }
    res.json(created);
  } catch (e) {
    console.error('Client photo save error:', e);
    res.status(500).json({ error: e.message });
  }
};

app.post('/api/admin/client-spots/:id/photos', requireAuth, resolveSpotUpload, runClientUpload, saveClientPhotos);
app.post('/api/admin/client-rooms/:id/photos', requireAuth, resolveRoomUpload, runClientUpload, saveClientPhotos);

// Only the keys actually present in the body are written, so a caller that
// edits the note alone can't silently clear the series tag. Column names come
// from this fixed list, never from the request.
app.put('/api/admin/client-photos/:id', requireAuth, async (req, res) => {
  const sets = [], vals = [];
  ['note', 'series'].forEach((col) => {
    if (!Object.prototype.hasOwnProperty.call(req.body, col)) return;
    vals.push((req.body[col] || '').trim().slice(0, col === 'series' ? 80 : 2000) || null);
    sets.push(`${col}=$${vals.length}`);
  });
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE client_photos SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING id, note, series`, vals
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.delete('/api/admin/client-photos/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM client_photos WHERE id=$1 RETURNING public_id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (rows[0].public_id) {
      cloudinary.uploader.destroy(rows[0].public_id)
        .catch(e => console.error('Client photo cleanup failed (non-fatal):', e.message));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The board page itself. noindex/nofollow belt-and-braces alongside robots.txt.
app.get('/client/:slug', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'client', 'index.html'));
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/api/coming-soon', (req, res) => res.json({ active: process.env.COMING_SOON === 'true' }));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Baji Prints running on port ${PORT}`));
}).catch(e => {
  console.error('Failed to init DB:', e);
  process.exit(1);
});
