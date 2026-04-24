require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs');
const session = require('express-session');
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'baji-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

// ── DEBUG ────────────────────────────────────────────────────────────────────
app.get('/api/debug/cloudinary', (req, res) => {
  res.json({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME ? 'set' : 'MISSING',
    api_key: process.env.CLOUDINARY_API_KEY ? 'set' : 'MISSING',
    api_secret: process.env.CLOUDINARY_API_SECRET ? 'set' : 'MISSING',
  });
});

// ── DB INIT ──────────────────────────────────────────────────────────────────
async function initDB() {
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    INSERT INTO content (key, value) VALUES
      ('hero_eyebrow', 'Fine art print atelier · Zürich Wiedikon'),
      ('hero_title_line1', 'Your work,'),
      ('hero_title_line2', 'finally'),
      ('hero_title_line3', 'on paper.'),
      ('hero_sub', 'A small, personal print atelier for photographers and digital artists — especially those who''ve never printed their work before. Fully colour-calibrated. No surprises.'),
      ('about_headline', 'Printing shouldn''t feel like a gamble.'),
      ('about_p1', 'Most photographers and digital artists never print their work. Not because it doesn''t deserve to be — but because the process feels opaque and the result unpredictable.'),
      ('about_p2', 'At Baji Prints I work with you directly: from file preparation through paper choice to the finished print. Everything is colour-managed and profiled — what you see on your screen is what you hold in your hands. I print on an Epson SC-P900 and a curated range of fine art papers, and I''ll help you find the right one.'),
      ('about_p3', 'Based in Wiedikon, Zürich. By appointment.'),
      ('paper1_name', 'Photo Rag Pearl'),
      ('paper1_desc', 'Warm-toned matte surface with a subtle pearlescent sheen. Deep blacks, beautiful gradation in the highlights. Versatile and forgiving — a strong starting point for most colour work.'),
      ('paper1_best', 'Best for — colour photography, portraits'),
      ('paper2_name', 'Photo Rag Satin'),
      ('paper2_desc', 'Smooth and refined, with a gentle satin finish that adds depth without glare. Wide colour gamut, excellent shadow detail. Works beautifully for both photography and digital art.'),
      ('paper2_best', 'Best for — colour & digital artwork'),
      ('paper3_name', 'Mono Silk Warmtone'),
      ('paper3_desc', 'Designed specifically for black & white. Warm base tone, silky surface, tonal range that rivals traditional darkroom fibre prints. Exceptional depth in the shadows.'),
      ('paper3_best', 'Best for — black & white photography'),
      ('papers_also', 'Other stocks available on request: fine art textured silk, textured cotton rag, heavyweight matt duo — and more to come. Just ask.'),
      ('contact_email', 'bajiprints@bharatbhatia.photography'),
      ('contact_location', 'Wiedikon, Zürich · by appointment'),
      ('contact_languages', 'English · Deutsch · Français'),
      ('hero_image_url', '')
    ON CONFLICT (key) DO NOTHING;
  `);
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
    const { rows } = await pool.query('SELECT * FROM prints ORDER BY sort_order ASC, created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CONTACT FORM ──────────────────────────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { name, email, interest, message } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  console.log(`[ENQUIRY] ${name} <${email}> — ${interest || 'no category'}: ${message || ''}`);

  if (!resend) {
    return res.json({ ok: true });
  }

  try {
    const { rows } = await pool.query("SELECT value FROM content WHERE key = 'contact_email'");
    const to = rows[0]?.value || process.env.EMAIL_TO || 'bajiprints@bharatbhatia.photography';

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
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme', 10);
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
app.post('/api/admin/upload/hero', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const url = req.file.path;
    await pool.query(
      "INSERT INTO content (key, value) VALUES ('hero_image_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [url]
    );
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN PRINTS ──────────────────────────────────────────────────────────────
app.post('/api/admin/prints', requireAuth, upload.single('image'), async (req, res) => {
  const { title, description, sort_order } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Image required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO prints (title, description, image_url, public_id, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, description || '', req.file.path, req.file.filename, parseInt(sort_order) || 0]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/prints/:id', requireAuth, async (req, res) => {
  const { title, description, sort_order } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE prints SET title=$1, description=$2, sort_order=$3 WHERE id=$4 RETURNING *',
      [title, description, parseInt(sort_order) || 0, req.params.id]
    );
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

// ── SERVE FRONTEND ────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Baji Prints running on port ${PORT}`));
}).catch(e => {
  console.error('Failed to init DB:', e);
  process.exit(1);
});
