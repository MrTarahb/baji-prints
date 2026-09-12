# bharatbhatia.photography — Technical Handoff

Everything needed to continue maintaining and developing this website in a new
chat. Strictly technical + the to-do list.

**Owner:** Bharat "Baji" Bhatia — Zürich-based fine art photographer.
**Working style:** informal, direct, decisive. Wants implementation-ready answers,
honest pushback, no over-selling. Runs his own git workflow and deploys himself —
Claude edits files, verifies (CSS brace-balance + `node --check`), presents them,
and supplies the git commands; Claude never runs git.
Tests on a **real Android Chrome device** (primary mobile validation).

> **This file is tracked in git** (as of 2026-09-10; it was previously kept out
> of the repo). It holds **no secret values** — only the *names* and purposes of
> the Railway env vars (§2) — but it does describe infrastructure, disaster
> recovery and business context, so treat everything here as visible to anyone
> who can see this repo.

---

## 0. Recent changes (session ~2026-07-28)

Security hardening (all deployed) + one regression caught and fixed:

- **Admin auth is now bcrypt.** Login checks `ADMIN_PASSWORD_HASH` (a bcrypt hash
  set in Railway) via `bcrypt.compare`, with a constant-time `safeEqual()`
  fallback to plaintext `ADMIN_PASSWORD` for migration. **`ADMIN_PASSWORD` has
  been deleted from Railway** — bcrypt is the only live path now. The old
  `|| 'changeme'` fallback is gone (login fails closed if nothing is configured).
  Added `const crypto = require('crypto')` near the top requires.
- **`/api/debug/cloudinary` is now gated behind `requireAuth`** (was public).
- **`/api/pageview` + `/api/photoview` are now rate-limited** via a shared
  `trackLimiter` (120/min per IP, `express-rate-limit`). Relies on the existing
  `app.set('trust proxy', 1)` for correct per-IP keying behind Railway.
- **Admin alt-text hint fixed:** "leave blank to auto-generate" → "leave blank for
  no alt text" (auto-generation was removed long ago; the label was stale).
- ⚠️ **Regression caught + fixed — lesson learned (see §8).** The bcrypt change
  was applied from a stale base and accidentally stripped **all** `alt_text` code
  out of `server.js` (the column migration, the `/api/prints` read, the shop
  query, and the save-route persistence). The admin field stayed but silently
  couldn't save or display alt text. **Data was never lost** — the DB column and
  rows survived; only the code that reads/writes them was gone. All four pieces
  were restored in a follow-up commit and alt text now shows again. Takeaway:
  **always rebuild edits from the live GitHub HEAD, not an earlier clone.**

> Line numbers below were refreshed for this session, but `server.js` grew ~40
> lines, so treat any remaining `~line` references as approximate.

---

## 1. Stack & infrastructure

| Layer | Tech |
|---|---|
| Backend | Node.js + Express (`server.js`, ~2,600 lines) |
| Database | PostgreSQL on Railway, raw parameterized SQL (no ORM) |
| Frontend | Vanilla JS SPA (`public/index.html`, ~4,300 lines), no framework |
| Admin | Separate SPA (`public/admin/index.html`, ~2,200 lines) |
| Animation | GSAP + ScrollTrigger (CDN) |
| Sessions | express-session + connect-pg-simple (Postgres-backed) |
| Auth | Single admin password, bcrypt via `ADMIN_PASSWORD_HASH` (`bcrypt.compare`; constant-time fallback) |

**npm dependencies:** express, express-rate-limit, pg, cloudinary, multer,
multer-storage-cloudinary, resend, stripe, bcryptjs, connect-pg-simple,
express-session, dotenv, cors
**Scripts:** `start` → `node server.js` · `dev` → `nodemon server.js`

### File structure
```
baji-prints/
├── server.js               ← Express app, DB init/seed/migrations, all API routes
├── package.json
├── README.md
├── PROJECT_HANDOFF.md      ← this file
└── public/
    ├── index.html          ← main site SPA
    └── admin/index.html    ← admin panel
```

### External services & how they connect

| Service | Role |
|---|---|
| **Railway** | Hosts the Node app + PostgreSQL. Deploy target. |
| **Cloudflare** | DNS. Points domain → Railway. Holds MX records for ImprovMX. |
| **Squarespace** | Domain registrar (`bharatbhatia.photography`). |
| **Cloudinary** | All image hosting + on-the-fly transforms. Cloud name: `dqsl63ax7`. Uploads via multer-storage-cloudinary. Old assets deleted on replace/remove. |
| **Stripe** | Checkout + webhook fulfilment. Card, TWINT, Google/Apple Pay. |
| **Resend** | Transactional email (order confirmations, contact-form notifications, shipped notices). |
| **ImprovMX** | Inbound email forwarding: `support@` + `contact@` → Gmail. Free tier. |
| **Gmail** | Inbox. Sends *as* support@/contact@ via "Send mail as" + **Google App Password** (needs 2FA). NOT ImprovMX SMTP. |
| **Meta Pixel** | ❌ **NOT installed** (verified — no `fbq`/pixel script in the codebase). Previously discussed as a *plan* only. If added later: retarget warm visitors / promote the workshop rather than cold-traffic shop ads. Note it would trigger cookie-consent obligations (CH/EU), so only worth adding shortly before running ads. **Owner explicitly wants no Meta tracking on the site.** |

> **Note on `og:` tags — do NOT remove them.** The Open Graph tags in `<head>`
> originated as a Facebook protocol but send **no data to Meta**. They are the
> universal standard for link previews (WhatsApp, iMessage, Signal, Telegram,
> Slack, LinkedIn, Discord). Removing them breaks link previews everywhere, which
> matters because the site link is shared directly with cafés/clients.
> The only other "facebook" string in the codebase is a **referrer display label**
> in the owner's own analytics query (`server.js` ~2538) — deliberately kept.
| **GitHub** | `github.com/MrTarahb/baji-prints.git` |

**Request flow:** visitor → Cloudflare DNS → Railway (Express serves SPA with
server-injected meta) → images fetched from Cloudinary → purchase goes to Stripe
Checkout → webhook back to Railway → order written to Postgres → Resend sends
confirmation.

---

## 2. Environment variables (set in Railway)

| Variable | Purpose | Fallback in code |
|---|---|---|
| `DATABASE_URL` | Postgres connection (SSL, `rejectUnauthorized:false`) | none — required |
| `PORT` | Server port | `3000` |
| `SESSION_SECRET` | express-session secret | **warns if unset** |
| `ADMIN_PASSWORD_HASH` | Admin panel login — bcrypt hash of the password | none — login fails closed if unset |
| ~~`ADMIN_PASSWORD`~~ | **Deleted from Railway.** Old plaintext var; code still reads it as a constant-time fallback only if `ADMIN_PASSWORD_HASH` is unset | n/a |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary | none |
| `CLOUDINARY_API_KEY` | Cloudinary | none |
| `CLOUDINARY_API_SECRET` | Cloudinary | none |
| `STRIPE_SECRET_KEY` | Stripe (Stripe disabled if unset) | none |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook signatures | none |
| `RESEND_API_KEY` | Resend (email disabled if unset) | none |
| `EMAIL_FROM` | Outgoing "from" | `noreply@bharatbhatia.photography` (one spot defaults to `hello@bajiprints.ch` — inconsistent, line ~1321) |
| `EMAIL_TO` | Where contact-form/order notifications land | `bhartu.bhatia@gmail.com` |
| `REPLY_TO_EMAIL` | Reply-to on outgoing mail | `bhartu.bhatia@gmail.com` |
| `COMING_SOON` | `'true'` shows a coming-soon gate | off |

**Diagnostic:** `GET /api/debug/cloudinary` reports which Cloudinary vars are
set/missing (now **behind `requireAuth`** — log in first).

---

## 3. Database schema

Tables created in `initDb()` on boot (`CREATE TABLE IF NOT EXISTS`), followed by
explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations.

**Tables:** `content` · `prints` · `categories` · `papers` · `print_sizes` ·
`faqs` · `shipping_settings` · `shipping_rates` · `eu_shipping_rates` ·
`personal_delivery_rates` · `orders` · `order_items` · `pageviews` ·
`photo_views` · `messages` · `workshop_dates` · `workshop_bookings` ·
`workshop_photos`

### `prints` — added columns (all via explicit ALTER)
`exclude_from_hero` · `exclude_from_category_hero` · `category` (legacy text) ·
`categories` (JSONB array) · `for_sale` · `edition_type` ('open'|'limited') ·
`edition_size` · `delivery_ch` · `delivery_personal` · `delivery_intl` ·
`shop_note` (legacy, superseded by `paper_id`) · `no_margin` (full-bleed flag) ·
`lifestyle_image_url` + `lifestyle_public_id` (in-situ photo) · `paper_id` (FK) ·
`alt_text` (hand-written image description; NULL = empty alt)

### Other notable columns
- `categories.description` — per-category prose shown between hero and feed
- `papers.weight_gsm` — used in shipping weight calc
- `orders.order_ref`, `orders.fulfilment_checklist` (JSONB), `orders.notes`
- `order_items.customer_note`
- `pageviews.referrer`
- `faqs` — `section, question, answer, sort_order, enabled` (fully admin-editable)

### `content` table
Key/value store for all editable site text. ~120 keys, e.g. `hero_name_1`,
`about_p1`, `shop_intro`, `workshop_*`, `impressum_*`, `nav_shop`,
`shop_no_margin_note`, `feed_show_print_badge` ('on'/'off' toggle).
Legacy `faq_*` and `faq_*_enabled` keys still exist but are **dead** (FAQ moved to
its own table) — harmless, safe to ignore or clean up.

---

## 4. API routes

### Public
```
GET  /api/content              GET  /api/faqs
GET  /api/prints               GET  /api/categories
GET  /api/shop/products        GET  /api/shop/shipping-rates
POST /api/shop/checkout        GET  /api/shop/order/:sessionId
POST /api/contact              GET  /api/personal-delivery-zones
GET  /api/workshops            GET  /api/workshop-photos
POST /api/pageview             POST /api/photoview
GET  /api/coming-soon
POST /api/stripe-webhook  +  POST /api/stripe/webhook   (raw body, sig-verified)
POST /api/shipping/calculate
GET  /robots.txt               GET  /sitemap.xml
```

### Admin (all behind `requireAuth`)
```
POST /api/admin/login | logout      GET  /api/admin/check
PUT  /api/admin/content
FAQ:      GET|POST /api/admin/faqs · PUT /api/admin/faqs/reorder · PUT|DELETE /:id
Prints:   POST /api/admin/prints · PUT /:id/image · PUT /reorder
          PUT|DELETE /:id/lifestyle · PUT|DELETE /:id
Uploads:  POST /api/admin/upload/hero · /upload/about-photo
Category: POST /api/admin/categories · PUT /reorder · PUT|DELETE /:id
Papers:   GET|POST /api/admin/papers · PUT|DELETE /:id
Shop:     GET /api/admin/shop/print/:id · PUT /:id · PUT /:id/forsale
          PUT /:id/size · POST /:id/reset-edition/:size
Shipping: GET|PUT /api/admin/shipping-settings · PUT /personal-delivery-rates
          GET|PUT /api/admin/shipping-rates
Orders:   GET /api/admin/orders · POST /:id/sync · PUT /:id/status
          PUT /:id/checklist · PUT /:id/notes · POST /:id/notify-shipped
          DELETE /api/admin/orders/clear-all
Workshop: GET|POST /api/admin/workshop-dates · PUT|DELETE /:id
          GET /api/admin/workshop-bookings
          POST /api/admin/workshop-photos · DELETE /:id · PUT /reorder
Stats:    GET /api/admin/stats · POST /api/admin/stats/reset
Messages: GET /api/admin/messages · PUT /:id/read · DELETE /:id
```

### SSR page routes (inject per-page meta — see SEO)
`GET /` · `/shop` · `/shop/:id` · `/shop/*` · `/cart` · `/workshops` · `/admin` · `*`

> ⚠️ **Express route order:** literal paths (`/reorder`, `/:id/image`,
> `/:id/lifestyle`) MUST be registered **before** `/:id`, or the param route
> swallows them. This has bitten the project multiple times.

---

## 5. SEO — already implemented (largely DONE)

This is well beyond a basic setup; check here before "adding SEO".

- **Server-side meta injection** — `serveWithMeta()` (server.js ~line 2221) reads
  `public/index.html`, regex-replaces `<title id="meta-title">`, `meta-desc`,
  `meta-og-title`, `meta-og-desc`, `meta-og-image`, `og:url`, and `canonical`,
  then injects JSON-LD before `</head>`. **The `id="meta-*"` attributes are load-
  bearing — don't rename them or SSR meta silently stops working.**
- **`ROUTE_META`** — per-route title + description for `/`, `/shop`, `/workshops`,
  `/about`, `/contact`, `/faq`. Art/prints focused, Zürich-weighted.
- **Product pages** — `/shop/:id` generates per-print title/description/image from
  the DB plus **Product JSON-LD** with price, currency CHF, availability.
- **Person JSON-LD** on every page (name, jobTitle, `sameAs` Instagram, address
  Zürich/CH, `knowsAbout` fine art photography / giclée printing / ICM / macro).
- **`/sitemap.xml`** — static routes + every for-sale print (`/shop/:id`), with
  changefreq/priority.
- **`/robots.txt`** — deliberate **middle-ground AI policy** (owner's decision):
  **allows** search engines (Googlebot, Bingbot, Applebot) and AI *retrieval*
  bots (OAI-SearchBot, ChatGPT-User, Claude-User, Claude-SearchBot,
  PerplexityBot) so the site stays discoverable in AI answers; **blocks** AI
  *training* crawlers (GPTBot, Google-Extended, ClaudeBot, Applebot-Extended,
  CCBot, Bytespider, Amazonbot) and **all Meta crawlers** (Meta-ExternalAgent,
  Meta-ExternalFetcher, FacebookBot). Blocking Google-Extended does **not** affect
  normal Google Search ranking. Caveats: robots.txt is voluntary, not retroactive,
  and images are served from Cloudinary (a domain this file doesn't cover).
  Crawler names change — revisit periodically. **Don't revert this to a blanket
  `Allow: /` — it's an intentional choice.**
- **`FAQPage` JSON-LD on `/faq`** — built from the live `faqs` table, so every
  question added in admin becomes machine-readable Q&A automatically. Most
  extractable format for AI answer engines + eligible for Google FAQ rich results.
- **Google Search Console verification** meta tag in `<head>`.
- `_indexHtmlCache` caches index.html in memory — **restart required for HTML
  changes to appear** (or clear the cache) since it's read once.

**Image alt text — owner-written, empty by default.**
`altText(title, kind, custom)` in `index.html` returns the print's hand-written
`alt_text` (from admin → **Manage prints → Alt text**) or an **empty string**.
Auto-generated fallbacks were deliberately removed — the owner is filling these
in himself. The one exception is the in-situ slide, which always falls back to
"Fine art print framed and hanging on a wall" because it depicts a *different*
image (a framed print in a room), so it must never inherit the artwork's alt text.
Applied to: portfolio feed, lightbox, shop cards (base + hover), cart thumbnail,
margin mockup, and both zoom overlays.

> **How to write alt text (for Baji):** describe **what is visibly in the photo**,
> in one plain sentence, as if describing it to someone who can't see it.
> ✅ *"Streetlight glowing through fog at night, abstract black and white"*
> ❌ *"fine art print Zürich buy photography giclée"* (keyword stuffing — Google
> penalises it and it makes screen readers useless).
> Aim for ~60–125 characters. Don't start with "Image of…" / "Photo of…" —
> screen readers already announce it's an image. No need to add your own name or
> "fine art print"; that context already exists on the page.
> ⚠️ **Until a print has alt text, its alt is empty** — which tells screen readers
> to skip the image entirely and gives image search nothing. Worth filling in
> reasonably soon rather than leaving half-done.

**Remaining SEO ideas (not done):** per-print keyword tuning, `og:type=product`
on shop pages, hreflang if German content is added.

---

## 6. Frontend architecture (`public/index.html`)

**SPA routing:** `showPage(name)` toggles section visibility;
`history.replaceState` syncs the URL (`/shop`, `/about`, `/faq`, `/workshops`…).

**Key functions:**
- `cld(url, w)` — Cloudinary transform builder: `w_<w>,f_auto,q_auto:good`,
  DPR-aware (×devicePixelRatio, capped ×2, hard max 2600px, skipped for ≤100px
  probe thumbs). **Duplicated in `admin/index.html` — keep both in sync.**
- `renderFeed()` / `pickHeroForFilter()` / `applyHeroOrientation()` — portfolio
  feed + orientation-aware hero (desktop never portrait, mobile never landscape).
- `initScrollAnimation()` — GSAP hero scrub + feed reveal (see Lessons #5/#6).
- Lightbox: `openLightbox` · `_renderLightbox` · `navigateLightbox` ·
  `toggleLightboxDesc` · `closeLightbox`. Story open/closed persists across photo
  navigation via `storyPref`; resets on full close.
- Shop: `openShopDetail` · `selectDetailSize` · `addSelectedToCart` ·
  `updateCartBar` · `groupCartItems` · `getShippingPriceForCart`.
- **Print viewer (`pv*`)** — `pvViewerHtml` builds a dynamic slide list
  (`pvState.slides`): full image / margin mockup / optional in-situ photo.
  `pvSwipeShell` wraps track + arrows + dots + label. `pvMockupHtml(p, forZoom)`
  renders the paper mockup. `pvOpenZoom` / `pvZoomSwitch` / `pvGo` / `pvOnScroll`.
- `toggleFaq` — expects a `.faq-q` button **immediately followed** by its `.faq-a`
  div (uses `nextElementSibling`); `renderFaqs()` must preserve that structure.

**Brand tokens:** fonts Playfair Display italic (`--fi`, headings/name) + DM Mono
(`--fm`, everything else). Colours: near-black `#111110`, off-white `#FAFAF8`,
bg-2 `#F0EFEC`, terracotta `--pink #C8907A` / `--pink-d #A87060`. Mockup paper is
pure `#FFFFFF`. Custom cursor: `cursor:none` site-wide.

### Print margin geometry (shop mockup)
- **A2 reference:** paper 42×59.4cm; margins **3.5cm** sides/top, **5.25cm**
  bottom (bottom always **1.5×** the sides).
- **Image window:** portrait **35 × 50.65cm** · landscape **52.4 × 33.25cm**.
- Margins **scale proportionally** by the paper's long edge vs A2 → A3 2.475/3.713,
  A4 1.75/2.625. Visually identical at every size, so **one mockup is rendered**,
  not one per size.
- Image is **fill-cropped** (`object-fit:cover`) into the window.
- Zoom computes **exact pixel dimensions in JS** (fit 90vw×82vh) rather than
  relying on `aspect-ratio` + `auto` (flex stretched it — Lesson #7).
- Admin has a self-computing **Margin reference** panel with the full table.

---

## 7. Admin panel (`public/admin/index.html`)

**Panels:** stats · messages · categories · prints · orders · shop · margins ·
papers · shipping · nav · hero · about · contact · impressum · faq · workshop ·
shoptext · footer · seo

**Editable-content system:** `buildFields(containerId, [[key, label, multiline,
options?], …])` → `makeField()` renders input / textarea / **select** (when a
4th `options` array `[[value,label],…]` is passed) → `saveField(key)` PUTs to
`/api/admin/content`. Reusable for any new text field or on/off toggle.

**Notable admin features:** FAQ full CRUD (add/edit/delete/reorder/enable),
replace print image, in-situ lifestyle photo upload/remove, margin reference
table, order fulfilment checklist + notes + shipped notification, edition reset,
stats, clear-orders modal with confirmation code.

---

## 8. Hard-won lessons — do not relearn these

1. **`CREATE TABLE IF NOT EXISTS` is a no-op on an existing table.** A column added
   inside a CREATE never reaches a live DB. **Always pair with explicit
   `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.**
2. **Seed loops must gate on `SELECT COUNT(*) = 0`**, not just
   `ON CONFLICT DO NOTHING` — otherwise deleting a seeded row lets the next deploy
   resurrect it (bit us with categories; FAQs are correctly gated).
3. **Express route order:** literal paths before `/:id`. Always.
4. **Never hardcode a category slug in the frontend** — derive from the live list,
   or an admin rename breaks the site.
5. **Mobile nav "slide" bug (long saga):** horizontal overflow detaches
   `position:fixed` from the visual viewport on Android Chrome. Root cause was the
   feed reveal animation's `x:±30` offset making the document wider than the
   screen (407px on a 392px viewport). **Guards now in place and load-bearing:**
   `overflow-x:clip` on `.feed-cols` AND `#main-content`, plus **`max-width:100vw`
   on the nav** (decisive — `left:0;right:0` resolves against *document* width on
   Android Chrome). Diagnose with `documentElement.scrollWidth` vs `clientWidth`,
   a zoom-out test, and an overflow-finder that lists elements exceeding the
   viewport.
6. **Feed reveal animation must be ONE GSAP tween** — items start `opacity:0` in
   CSS, GSAP animates `{y:50, x:±30, opacity:0} → {y:0, x:0, opacity:1}`.
   A *separate* image-fade-on-load layer desynced from the slide and read as
   "jump then slide"; it was removed. Don't reintroduce a second opacity
   mechanism. The x-offset is only safe because of the Lesson-5 guards.
7. **`aspect-ratio` + `width:auto` on a flex child gets stretched** — compute exact
   px in JS when precision matters (this broke the portrait margin mockup zoom).
8. **`mix-blend-mode` breaks `position:fixed` on Android Chrome** — avoid inside
   fixed subtrees; use text-shadow/box-shadow for legibility instead.
9. **Image quality:** bare `q_auto` bands/blotches dark smooth gradients (badly,
   when `f_auto` serves AVIF to Chrome). Use **`q_auto:good`**. Feed images are
   right-sized to `w_800` (→1600 at 2× DPR) so they load fast — oversized feed
   images made the layout-shift "jump" visible.
10. **`getOrientation(url)` returns a STRING** (`'landscape'`/`'portrait'`).
    It was briefly refactored to an object and broke the hero + shop detail.
11. **`_indexHtmlCache`** means server restarts are needed for `index.html`
    changes to show via SSR routes.
12. **Cached renders:** the user sometimes sees a stale version until a hard
    refresh / incognito. Rule out cache before deep-debugging a "broken" fix.
13. **Email testing:** sending to `support@`/`contact@` **from the same Gmail that
    receives the forward** looks broken — Gmail de-duplicates and hides it (it's in
    *All Mail*). Always test from an unrelated address.
14. **Always edit from the LIVE GitHub HEAD, never an earlier clone.** A `server.js`
    handed over for the bcrypt change was built from a clone taken earlier in the
    same session, before the `alt_text` work existed — committing it silently
    reverted every `alt_text` change (migration, `/api/prints` read, shop query,
    save route). Symptom was "alt text saved but not showing." Re-clone fresh (or
    pull) before editing, and after any multi-step edit, `git diff` against HEAD
    should show **only** the intended change. (The DB column/rows were untouched,
    so no data was lost — but the code round-trip was.)

### Verification workflow used in this project
```bash
# CSS brace balance + extract main script, then syntax-check
python3 -c "import re; c=open('public/index.html').read();
s=re.search(r'<style>(.*?)</style>', c, re.S).group(1);
assert s.count('{')==s.count('}'), 'CSS imbalance'; print('✓ CSS balanced')"
node --check /tmp/extracted.js
```
Then `present_files`, and **the user runs git himself** (Claude supplies the
commands, never runs them).

---

## 9. Known issues / tech debt

**Resolved this session (~2026-07-28) — see §0:**
- ✅ Admin login is now **bcrypt** (`ADMIN_PASSWORD_HASH`); `changeme` fallback
  removed; login fails closed if unset.
- ✅ **`/api/debug/cloudinary`** now behind `requireAuth`.
- ✅ **`/api/pageview` + `/api/photoview`** now rate-limited (`trackLimiter`,
  120/min per IP).

**Still open (reviewed, deliberately deferred):**
- `EMAIL_FROM` default is inconsistent (`noreply@bharatbhatia.photography` in
  three places, `hello@bajiprints.ch` in one, ~line 1321). Harmless while
  `EMAIL_FROM` is set in Railway (it is) — dismissed as non-urgent.
- Contact-form email interpolates `name`/`email`/`message` raw (no `esc()`),
  unlike the order emails. Goes to owner's own inbox, so low risk — dismissed.
- Dead legacy `faq_*` content keys remain after the FAQ table migration.
- `prints.category` (text) and `prints.shop_note` are legacy, superseded by
  `categories` (JSONB) and `paper_id`.

---

## 10. TO-DO LIST

### High priority
- **Workshop "Photo to Print" — Stripe booking flow.** ✅ *Done & deployed
  (2026-09-12).* The full flow is live: `/workshops/<slug>` "Book your spot" →
  `POST /api/workshops/:slug/book` → Stripe Checkout (`metadata.type='workshop'`,
  server-side capacity re-check, price read from the date row) → webhook branch
  `fulfilWorkshopBooking` (mirrors print idempotency) → admin notification + guest
  confirmation email (from `contact@`; subject/opening/closing editable per workshop
  via the page's "Booking email" button) + Stripe PDF invoice. The only gate now is
  a `workshop_dates` row being set to `open`. Concept as built: CHF 300pp, full day,
  max 6 / min 4, all-inclusive, A2 shipped after.
- **Workshop co-teacher — Tuule Müürsepp.** ✅ *Section built & deployed
  (2026-09-12).* A "Co-teacher" section is on the workshop page (after "The day"),
  with her name seeded and editable name / bio / website-URL fields on the page's own
  edit tabs; the name links out to her site once a URL is set, and the section shows
  publicly once a bio or a valid link exists. **Remaining:** fill in her real bio +
  website URL (from the edit tabs, or hand them to Claude to seed), and decide whether
  to add a portrait (would need an image field — text + link only for now).
- **Manage workshop bookings from the admin.** ✅ *Built & deployed (2026-09-12).* Each date in
  the workshop page's Dates modal has a **Bookings** button → a guest list (name, email as a
  mailto, booking ref, amount, booked date, dietary/notes, status) with a confirmed-count +
  revenue summary. Shows paid guests + anyone actively checking out (<35 min) + any
  cancelled/refunded rows (dimmed, kept for the record); stale abandoned-checkout `pending` rows
  are filtered out. Each row can be **edited** (status + contact/dietary/notes — e.g. mark a
  Stripe-refunded booking `refunded`, which drops it from the confirmed count and frees the
  seat) or **deleted** — via `PUT`/`DELETE /api/admin/workshop-bookings/:id` (partial-update
  allow-list, placeholders counted not interpolated). Neither touches Stripe: a refund is issued
  in Stripe itself, then recorded here. **Deferred:** issuing the Stripe refund from the app,
  CSV export of a date's guest list, and a mark-attended flag.
- **Workshop student discount.** Offer a reduced student rate. Owner wants to choose
  either (a) a discount off the normal price (amount or %), or (b) a separate student
  price — admin-settable. At booking the participant self-selects "I'm a student" to get
  it. Price MUST stay server-authoritative like the normal flow (which reads
  `price_chf_cents` from the `workshop_dates` row): add e.g. `student_price_chf_cents`
  (or a discount field) + a booking flag the server validates — never trust a
  client-sent price. Decide whether any student proof is required (likely honour system).
- **Workshop terms of sale.** Draft workshop-specific terms (cancellation/refund window,
  the min-4-participants reschedule/refund clause, what's included) — separate from the
  general shop terms — and require acceptance at booking (a checkbox on the workshop page,
  or Stripe Checkout `consent_collection.terms_of_service` pointing at a hosted terms URL).

### Content & shop
- **Write alt text for every print** (admin → Manage prints → Alt text). Owner is
  doing this himself over the coming days; alt is empty until filled. See §5 for
  how to write them.
- **Discount codes** at checkout
- Audit/remove all em-dashes site-wide

### Conversion & UX
- "X of Y remaining" on limited edition cards
- ❌ Back-to-top button — explicitly **not wanted**

### Shop & payments
- Stripe tax / compliance
- Optional frame add-on at checkout
- Show personal delivery as a **service fee**, not a shipping cost
- Customs handling for international orders
- Edition tracking: captcha-style reset confirmation + auto vs manual gate *(parked)*

### Analytics
- Funnel analytics (shop → cart → checkout drop-off)
- **Guerrilla QR sticker tracking** — `?ref=sticker-<location>` UTM-style tags
  logged to Postgres + a breakdown in admin. **Settle the naming convention before
  printing stickers** (physical codes can't be changed later).

### SEO (mostly done — see §5)
- Per-print keyword tuning, `og:type=product` on shop pages

### Tech debt
- Security items (bcrypt, debug endpoint, tracking rate-limit) **done** this
  session — see §0/§9. Remaining §9 open items are minor and deferred.
