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
# For each of the three HTML SPAs: extract the <script> block to a temp file and
# `node --check` it, and assert the <style> block's { } counts match.
```

Restarting the server is required for `public/index.html` edits to appear on SSR routes
(`indexHtml()` caches the file in `_indexHtmlCache` at `server.js:2347`).

There is no local `.env` — Cloudinary/Stripe/Resend credentials live only in Railway, so
nothing that calls an external API can be tested from the working tree. What *can* be checked
locally is render logic: the client board's `<script>` runs under `node:vm` against a stub
`document` and fixture board data, which is how the series/filename behaviour was verified.

## Architecture

Four tracked source files. Everything else is `node_modules` / config.

| File | ~Lines | Role |
|---|---|---|
| `server.js` | 3,300 | Entire Express app: schema init/migrations/seeds, all API routes, Stripe webhook, email, SSR meta injection |
| `public/index.html` | 4,300 | Public site — vanilla-JS SPA, inline `<style>` + `<script>`, no framework, no bundler |
| `public/admin/index.html` | 2,250 | Admin panel — separate vanilla-JS SPA |
| `public/client/index.html` | 1,075 | Private client proofing boards — separate vanilla-JS SPA, German UI |

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
explicit `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `initDB()` (`server.js:562`).

**Seeding.** Seed loops gate on `SELECT COUNT(*) = 0`, not `ON CONFLICT DO NOTHING` — otherwise
deleting a seeded row lets the next deploy resurrect it.

**Middleware order matters.** The Stripe webhook is mounted with `express.raw` *before*
`express.json()` (`server.js:472`) — signature verification needs the raw body. `app.set('trust
proxy', 1)` is load-bearing for per-IP rate limiting behind Railway.

**Route order.** Literal paths before `/:id` params, always (e.g. `/api/admin/prints/reorder`
before `/api/admin/prints/:id`).

**Webhook idempotency.** Order fulfilment claims the pending→paid transition with an atomic
`UPDATE … WHERE status='pending' RETURNING`. Any duplicate delivery sees zero rows and exits.
Don't weaken this — it guards edition counters and duplicate emails.

**Cloudinary URL builder is triplicated.** `cldUrl()` in `server.js:286`, `cld()` in
`public/index.html:2716`, `cld()` in `public/admin/index.html:749`. Keep them in sync. Use
`q_auto:good`, never bare `q_auto` (bands dark gradients when `f_auto` serves AVIF).

**Cloudinary cleanup is per-route and two routes leak** (known, accepted, left as-is). Deleting
a row does not delete the asset unless that route says so. `DELETE /api/admin/prints/:id`
(`server.js:1838`) destroys only `public_id` and **misses `lifestyle_public_id`**, so a print
with an in-situ photo orphans it; its `destroy` is also `await`ed without a `.catch`, unlike
every other cleanup here, so a Cloudinary outage 500s the request and the row survives.
`POST /api/admin/upload/hero` and `…/about-photo` store only a URL — no `public_id`, no destroy
— so every replacement orphans the previous image. Everything else (prints' main/lifestyle
image *replacement*, workshop photos, all three client-board deletes) cleans up correctly.
When adding an image-bearing table, follow the client-board pattern: collect `public_id`s
*before* a cascading delete, destroy after, and treat the destroy as non-fatal.

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

**The board is bilingual by audience, and this is deliberate.** Anything the client sees is
**German** (login gate, approve/decline buttons, tallies, status pills, empty states on his
side). Anything only the admin sees is **English** — the admin bar, all add/edit/delete
controls, every modal dialog, `confirm()` text, toasts, the lightbox admin strip, and the
reaction notification email. Where one element serves both audiences (an empty state, a save
indicator), the admin branch is English and the client branch German. Dialog *labels* are
English but the *values* typed into them are client-facing, so they get written in German.

Two kinds of text sit side by side and must not be conflated: **`note`** (on rooms, spots and
photos) is the photographer's own comment shown *to* the client, while **`client_comment`** is
the client's reply. They render differently on purpose. Header text — `clients.eyebrow`,
`clients.name`, `clients.intro` — is editable inline; `eyebrow` and `intro` are nullable and
fall back to defaults, `name` never blanks (`COALESCE` keeps the old value). `intro` is full
width and `white-space:pre-wrap`, so the newlines typed into its textarea survive as paragraphs
(`.note` does the same — keep them consistent).

**Admin-only data is withheld from the client's payload, never merely hidden in the page.**
`GET /api/client/:slug/board` strips fields from `photos` before serialising, so opening
devtools on the board reveals nothing: `original_name` and `public_id` always, and `series`
too unless that board's series have been released. Follow this whenever something is "for the
photographer only" — a CSS-only `.adm` gate is for *controls*, not for *data*. The frontend
also gates rendering on `isAdmin`, but that is belt-and-braces, not the guard.

- **A spot may be unnamed, and that is the "room with no spots" case.** Photos always
  belong to a spot in the schema, so a room that needs only one obvious place holds a single
  spot with `name=''`, rendered with no spot header — its photos read as the room's own. The
  room head then offers `+ Photos` (`POST /api/admin/client-rooms/:id/photos`), which files
  them into that unnamed spot, creating it *after* the upload succeeds so a failed upload
  leaves no empty spot on the board. `POST …/spots` treats a blank `name` as deliberate and
  only falls back to `'New spot'` when the field is absent. Anything that prints a location
  (lightbox header, reaction email) must drop the `·` separator when the spot has no name.
- **A room with more than one spot lays its spots out as columns** (`.spots.multi`, a
  `repeat(auto-fit, minmax(min(330px,100%),1fr))` grid). Two guards are load-bearing: the
  `min()` stops a track from exceeding a narrow container, and `min-width:0` on the column
  overrides a grid item's `min-width:auto`, which the `.card` `min-width` inside would
  otherwise inflate — either one missing gives the page a horizontal scrollbar.
- **Rooms reorder with ↑/↓ buttons, not drag-and-drop** — the board gets used on a phone,
  where a long-press drag fights the page scroll. `moveRoom()` is optimistic: it rearranges
  `board.rooms`, repaints, and only reloads if `PUT …/client-rooms/reorder` fails.
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
- **A "Serie" is a tag on the photo plus a filter, deliberately *not* a level above rooms.**
  `client_photos.series` is free text (NULL = untagged) and the chip row is derived from the
  distinct values actually present — there is no series table and nothing to keep in sync, and
  a typo surfaces immediately as an extra chip. Nesting rooms under series was rejected on
  purpose: it would duplicate the room/spot geometry once per series, break side-by-side
  comparison of candidates for one wall, and force a second reaction primitive next to the
  per-photo `status`. If asked to "add series properly", this *is* the considered design.
  - One series for a whole upload batch (asked **after** the file picker — putting a modal's OK
    click between the button press and `picker.click()` gets the file dialog blocked on mobile);
    corrections happen per photo in the lightbox **Edit** dialog.
  - Chips address values **by index** (`chipVals`), never by interpolating the name into an
    `onclick` — series names are free text and may contain quotes.
  - Filtering **keeps the gaps visible**: a room or spot the current series skips stays on the
    page with a German `.gap` line, rather than vanishing. A room-level gap replaces the spots
    entirely; a spot-level gap sits inside the column. A genuinely empty spot still says „Fotos
    folgen" — a series that skips a wall and a wall not yet shot must read differently.
  - The tally follows the filter (so it reads as that series' score); the admin's unseen-response
    badge deliberately does not. The lightbox navigates within the filtered set.
  - `clients.series_visible` (default **FALSE**) gates whether the client sees any of it. While
    off, the admin keeps chips, filter and labels and the chip row says so inline; the client
    gets the board exactly as it read before series existed. `render()` also self-heals a filter
    pointing at a vanished series, and never leaves a non-admin on the `''` (untagged) view.
- **`client_photos.original_name`** is the filename as uploaded — admin-only, and a working aid
  for tracing a board photo back to the original. Never fall back to the Cloudinary `public_id`
  when it is missing: that is a hash and shows nothing useful. Rows predating the column have
  no name; `POST /api/admin/clients/:slug/recover-filenames` asks Cloudinary for
  `original_filename` (which omits the extension — `format` supplies it) and reports what it
  actually found, and the Edit dialog can always set it by hand. `clientStorage` now uploads
  with `use_filename` + `unique_filename` so new assets are findable in the media library too.
- `PUT /api/admin/client-photos/:id` writes **only the body keys actually present**, so a caller
  editing one field can't null the others. Column names come from a fixed list, never the request.
- The client grid is a **justified gallery and nothing is ever cropped**: `flex-basis = ar ×
  ROW_H` with `flex-grow = ar` makes every photo in a row resolve to the same height. `width` /
  `height` are captured from Cloudinary at upload so the ratio is known on first paint; older
  rows without them fall back to 3:2 and self-correct via `adjustRatio()` on load. Each card is
  capped at `max-width: calc(var(--ar) * 68vh)` — without that a portrait on a narrow viewport
  lays out ~1.5× the container width and runs off the screen. On mobile `min-width` must stay
  `0`, because `min-width` beats `max-width` and would defeat that cap.
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
