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
  ch:       'Standard shipping (Switzerland / Liechtenstein)',
  personal: 'Personal delivery (Switzerland / Liechtenstein)',
  intl:     'International shipping',
};

// Where customer replies to order emails should actually land — noreply@ can't
// receive mail, so we set this as the reply-to header instead.
const REPLY_TO_EMAIL = process.env.REPLY_TO_EMAIL || 'bhartu.bhatia@gmail.com';

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
const upload = multer({ storage });

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


app.get('/api/debug/cloudinary', (req, res) => {
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
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'abstract';
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS categories JSONB DEFAULT '["abstract-bnw"]'::jsonb;

    -- ── SHOP: per-print sale settings ──────────────────────────────
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS for_sale BOOLEAN DEFAULT FALSE;
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS edition_type TEXT DEFAULT 'open'; -- 'open' or 'limited'
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS edition_size INTEGER; -- e.g. 25, only used if limited
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS delivery_ch BOOLEAN DEFAULT TRUE;
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS delivery_personal BOOLEAN DEFAULT FALSE;
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS delivery_intl BOOLEAN DEFAULT FALSE;
    ALTER TABLE prints ADD COLUMN IF NOT EXISTS shop_note TEXT; -- print/paper description shown in shop detail (legacy, replaced by paper_id)

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
    // FAQ visibility flags — 'false' hides that question on the site
    ['faq_paper_enabled','true'],['faq_sizes_enabled','true'],['faq_signed_enabled','true'],
    ['faq_limited_enabled','true'],['faq_margin_enabled','true'],['faq_how_order_enabled','true'],
    ['faq_payment_enabled','true'],['faq_custom_print_enabled','true'],['faq_packaging_enabled','true'],
    ['faq_delivery_time_enabled','true'],['faq_intl_enabled','true'],['faq_shipping_cost_enabled','true'],
    ['faq_personal_what_enabled','true'],['faq_personal_where_enabled','true'],['faq_personal_how_enabled','true'],
    ['faq_damaged_enabled','true'],['faq_returns_enabled','true'],['faq_framing_enabled','true'],
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

  console.log('DB initialised');
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.admin) return next();
  res.status(401).json({ error: 'Unauthorised' });
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

app.get('/api/prints', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, title, description, image_url, public_id, sort_order, exclude_from_hero, category, categories, created_at FROM prints ORDER BY sort_order ASC, created_at DESC');
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
              p.delivery_ch, p.delivery_personal, p.delivery_intl, p.shop_note,
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

      if (row.edition_type === 'limited' && row.edition_size != null && row.edition_sold >= row.edition_size) {
        return res.status(400).json({ error: `${row.title} (${row.size}) is sold out` });
      }
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
      payment_method_types: ['card'],
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

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  const match = password === (process.env.ADMIN_PASSWORD || 'changeme');
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

app.put('/api/admin/prints/:id', requireAuth, async (req, res) => {
  const { title, description, sort_order, exclude_from_hero, category, categories } = req.body;
  // categories is the new multi-value array; category is the legacy single string kept for compatibility
  const cats = Array.isArray(categories) && categories.length ? categories : [category || 'abstract-bnw'];
  const primaryCat = cats[0]; // keep legacy category column in sync with first selection
  try {
    let query, params;
    if (sort_order !== undefined) {
      query = 'UPDATE prints SET title=$1, description=$2, sort_order=$3, exclude_from_hero=$4, category=$5, categories=$6 WHERE id=$7 RETURNING *';
      params = [title, description, parseInt(sort_order) || 0, !!exclude_from_hero, primaryCat, JSON.stringify(cats), req.params.id];
    } else {
      query = 'UPDATE prints SET title=$1, description=$2, exclude_from_hero=$3, category=$4, categories=$5 WHERE id=$6 RETURNING *';
      params = [title, description, !!exclude_from_hero, primaryCat, JSON.stringify(cats), req.params.id];
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
      `SELECT id, title, for_sale, edition_type, edition_size, delivery_ch, delivery_personal, delivery_intl, shop_note, paper_id
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
  const { for_sale, edition_type, edition_size, delivery_ch, delivery_personal, delivery_intl, shop_note, paper_id } = req.body;
  try {
    await pool.query(
      `UPDATE prints SET for_sale=$1, edition_type=$2, edition_size=$3,
       delivery_ch=$4, delivery_personal=$5, delivery_intl=$6, shop_note=$7, paper_id=$8 WHERE id=$9`,
      [!!for_sale, edition_type || 'open', edition_size || null, !!delivery_ch, !!delivery_personal, !!delivery_intl, shop_note || null, paper_id || null, req.params.id]
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

// ── PAGEVIEW TRACKING ────────────────────────────────────────────────────────
// Track visits to the main site (not admin, not API)
app.post('/api/pageview', async (req, res) => {
  try {
    const { path, referrer } = req.body;
    await pool.query(
      'INSERT INTO pageviews (path, referrer) VALUES ($1, $2)',
      [path || '/', referrer || null]
    );
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.post('/api/photoview', async (req, res) => {
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
  res.send('User-agent: *\nAllow: /\nSitemap: https://bharatbhatia.photography/sitemap.xml');
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://bharatbhatia.photography/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
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
