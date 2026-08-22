# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Baji Prints — fine art print atelier site for Bharat "Baji" Bhatia (Zürich). Portfolio + shop
(Stripe checkout) + workshops + admin CMS, live at `bharatbhatia.photography`.

## Commands

```bash
npm install
npm run dev     # nodemon server.js
npm start       # node server.js
```

No test suite, no linter, no build step. Verification before committing is manual:

```bash
node --check server.js
# For public/index.html and public/admin/index.html: extract the <script> block to a
# temp file and `node --check` it, and assert the <style> block's { } counts match.
```

Restarting the server is required for `public/index.html` edits to appear on SSR routes
(`indexHtml()` caches the file in `_indexHtmlCache` at `server.js:2194`).

## Architecture

Three tracked source files. Everything else is `node_modules` / config.

| File | ~Lines | Role |
|---|---|---|
| `server.js` | 2,650 | Entire Express app: schema init/migrations/seeds, all API routes, Stripe webhook, email, SSR meta injection |
| `public/index.html` | 4,300 | Public site — vanilla-JS SPA, inline `<style>` + `<script>`, no framework, no bundler |
| `public/admin/index.html` | 2,200 | Admin panel — separate vanilla-JS SPA |
| `public/client/index.html` | 700 | Private client proofing boards — separate vanilla-JS SPA, German UI |

Stack: Node 18+ / Express · PostgreSQL on Railway (raw parameterized SQL, no ORM) ·
Cloudinary (images + transforms) · Stripe (checkout + webhook) · Resend (email) ·
express-session + connect-pg-simple · GSAP/ScrollTrigger from CDN.

Request flow: Cloudflare DNS → Railway/Express (serves the SPA with server-injected `<meta>`)
→ images from Cloudinary → purchase → Stripe Checkout → webhook → Postgres → Resend.

Deploy: push to `main` → Railway auto-deploys. Env vars live in Railway (see `.env.example`;
`PROJECT_HANDOFF.md` §2 has the authoritative table, including `ADMIN_PASSWORD_HASH`,
`STRIPE_WEBHOOK_SECRET`, `REPLY_TO_EMAIL`, `COMING_SOON`).

### `PROJECT_HANDOFF.md`

A ~32KB technical handoff doc sits in the working tree but is **gitignored — never `git add`
it**. It is the deepest reference for schema, routes, SEO, frontend internals, print-margin
geometry, disaster recovery, and the to-do list. Read it when a task touches an area this file
only summarizes.

## Conventions and traps specific to this codebase

**Schema migrations.** `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a
column added inside a `CREATE` never reaches the live DB. Every new column must also get an
explicit `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `initDB()` (`server.js:540`).

**Seeding.** Seed loops gate on `SELECT COUNT(*) = 0`, not `ON CONFLICT DO NOTHING` — otherwise
deleting a seeded row lets the next deploy resurrect it.

**Middleware order matters.** The Stripe webhook is mounted with `express.raw` *before*
`express.json()` (`server.js:450`) — signature verification needs the raw body. `app.set('trust
proxy', 1)` is load-bearing for per-IP rate limiting behind Railway.

**Route order.** Literal paths before `/:id` params, always (e.g. `/api/admin/prints/reorder`
before `/api/admin/prints/:id`).

**Webhook idempotency.** Order fulfilment claims the pending→paid transition with an atomic
`UPDATE … WHERE status='pending' RETURNING`. Any duplicate delivery sees zero rows and exits.
Don't weaken this — it guards edition counters and duplicate emails.

**Cloudinary URL builder is triplicated.** `cldUrl()` in `server.js:264`, `cld()` in
`public/index.html:2716`, `cld()` in `public/admin/index.html:737`. Keep them in sync. Use
`q_auto:good`, never bare `q_auto` (bands dark gradients when `f_auto` serves AVIF).

**Never hardcode a category slug in the frontend** — derive it from the live category list, or
an admin rename breaks the site.

**Auth** is a single admin password: `bcrypt.compare` against `ADMIN_PASSWORD_HASH`, with a
constant-time `safeEqual()` fallback to plaintext `ADMIN_PASSWORD` (deleted in production).
Fails closed if neither is set. All `/api/admin/*` routes sit behind `requireAuth`.

### Client proofing boards (`/client/<slug>`)

Private, password-protected pages where a commissioning client picks photos for their space.
Schema: `clients` → `client_rooms` → `client_spots` → `client_photos`, with the client's
reaction (`status` / `client_comment` / `reacted_at`) written straight onto the photo row —
one client per board, so there is no separate feedback table.

Two kinds of text sit side by side and must not be conflated: **`note`** (on rooms, spots and
photos) is the photographer's own comment shown *to* the client, while **`client_comment`** is
the client's reply. They render differently on purpose. Header text — `clients.eyebrow`,
`clients.name`, `clients.intro` — is editable inline; `eyebrow` and `intro` are nullable and
fall back to defaults, `name` never blanks (`COALESCE` keeps the old value).

- **The client session is a separate role from admin.** `req.session.client_slug` is scoped to
  one board; `requireBoardAccess` allows that client or any admin. Client login never sets
  `req.session.admin`, and client logout never clears it.
- **Management is inline on the board**, not in `/admin` — opening `/client/<slug>` while
  logged in as admin reveals the add/edit controls. `/admin` only links to boards and shows an
  unseen-feedback count.
- Nothing about a board is public: excluded in `robots.txt`, `X-Robots-Tag: noindex` on the
  route, absent from `sitemap.xml`, and the session probe returns an identical response for an
  unknown slug, a locked board, and a logged-out visitor so a guessed URL confirms nothing.
- Approvals are **independent per photo** — approving one candidate never changes the others in
  the same spot. Clicking the active choice again clears it back to `pending`.
- Uploads go to Cloudinary `baji-clients/<slug>/` via `clientStorage`, whose folder is resolved
  per request from `req.uploadClientSlug` — the route must set that *before* multer runs.
- Deleting a room or spot cascades in Postgres, so the route collects `public_id`s **before**
  the delete and destroys the Cloudinary assets afterward, or they orphan.
- **Renaming a live column** needs a guard — plain `ALTER TABLE … RENAME` is not idempotent and
  would throw on the next deploy, and a throw in `initDB()` exits the process and takes the
  whole site down. The `caption` → `note` migration in `initDB()` is the pattern: a `DO $$`
  block that renames only if the old column exists *and* the new one does not, followed by
  `ADD COLUMN IF NOT EXISTS` so fresh databases get it too.

### Frontend gotchas (`public/index.html`)

- **Horizontal overflow detaches `position:fixed` on Android Chrome** — this caused a long-lived
  mobile nav bug. The guards are load-bearing: `overflow-x:clip` on `.feed-cols` *and*
  `#main-content`, plus `max-width:100vw` on the nav. Don't remove them; diagnose regressions
  with `documentElement.scrollWidth` vs `clientWidth`.
- **The feed reveal must stay one GSAP tween.** Items start `opacity:0` in CSS; GSAP animates
  `{y:50, x:±30, opacity:0} → {y:0, x:0, opacity:1}`. A second opacity mechanism desyncs and
  reads as "jump then slide".
- `mix-blend-mode` also breaks `position:fixed` on Android Chrome — use text/box-shadow instead.
- `getOrientation(url)` returns a **string** (`'landscape'`/`'portrait'`), not an object.
- `toggleFaq` relies on each `.faq-q` button being the immediate previous sibling of its
  `.faq-a` — `renderFaqs()` must preserve that structure.
- When exact geometry matters (print margin mockups), compute pixel sizes in JS;
  `aspect-ratio` + `width:auto` gets stretched on a flex child.

## Working style

The owner runs git and deploys himself and tests on a real Android Chrome device. Prefer
presenting edits plus the git commands over running git. Before any multi-step edit, work from
the current `main` HEAD — a past session rebuilt `server.js` from a stale clone and silently
reverted an entire feature (`alt_text`); afterwards, `git diff` should show only the intended
change.
