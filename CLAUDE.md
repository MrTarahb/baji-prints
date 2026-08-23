# CLAUDE.md

## Project

Baji Prints — fine art print atelier site for Bharat "Baji" Bhatia (Zürich). Portfolio + shop
(Stripe checkout) + workshops + admin CMS, live at `bharatbhatia.photography`.

## Commands

No test suite, no linter, no build step. Verification before committing is manual:

```bash
node --check server.js
# For each of the three HTML SPAs: extract the <script> block to a temp file and
# `node --check` it, assert the <style> block's { } counts match, and assert the
# file contains no control characters (see below).
```

**Check the HTML files for stray control characters.** A NUL or other control byte written
into a string literal is valid JavaScript and passes `node --check`, so it ships silently —
but an HTML parser turns it into U+FFFD, so any round-trip comparison against that literal
then fails in the browser only. This bit a sentinel value in the client board. Guard with
`/[\x00-\x08\x0B\x0C\x0E-\x1F]/` over the file; `grep` reporting "Binary file … matches" on a
source file is the same smell.

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
`GET /api/client/:slug/board` trims `photos` before serialising, so opening devtools on the
board reveals nothing: photos of an unreleased series are dropped from the array outright,
`original_name` and `public_id` always stripped, and `series` too unless the names are
released. Follow this whenever something is "for the photographer only" — a CSS-only `.adm`
gate is for *controls*, not for *data*. The frontend also gates rendering on `isAdmin`, but
that is belt-and-braces, not the guard.

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
  - **Tagging is a `<select>` on each card**, admin-only, options built by `seriesOptions()` from
    the live board plus "no series" and "+ New series…" (sentinel `NEW_OPT`). That one builder
    feeds the card picker, the upload dialog and the photo dialog so they can't drift. The card
    picker needs `onclick="event.stopPropagation()"` — the whole card opens the lightbox.
  - One series for a whole upload batch (asked **after** the file picker — putting a modal's OK
    click between the button press and `picker.click()` gets the file dialog blocked on mobile).
  - `ask()` supports two field types beyond text: pass `options` for a `<select>` plus a
    "new value" input revealed only when `NEW_OPT` is chosen, or `checks` for a checkbox list
    whose answer is an **array** of ticked values rather than a string.
  - With fewer than two series there is no filter to offer, so the chip row instead carries an
    admin-only line saying why (nothing tagged / only one series). Without it, "show me one
    series" reads as broken when the real answer is that no photo carries a tag yet.
  - Chips address values **by index** (`chipVals`), never by interpolating the name into an
    `onclick` — series names are free text and may contain quotes.
  - Filtering **keeps the gaps visible**: a room or spot the current series skips stays on the
    page with a German `.gap` line, rather than vanishing. A room-level gap replaces the spots
    entirely; a spot-level gap sits inside the column. A genuinely empty spot still says „Fotos
    folgen" — a series that skips a wall and a wall not yet shot must read differently.
  - The tally follows the filter (so it reads as that series' score); the admin's unseen-response
    badge deliberately does not. The lightbox navigates within the filtered set.
  - **Two separate controls, and conflating them is the mistake to avoid.**
    `clients.visible_series` (JSONB array, `''` = untagged, **NULL = no restriction**) decides
    *which photos reach the client at all* — an unreleased series is filtered out of his payload
    in the board route, so he cannot see those photos by any means. `clients.series_visible`
    (bool) only decides whether he is told the *names* (chips + labels) of what he can already
    see. Hiding names does **not** hide photos; that was a bug once. Both are set from one
    admin-bar dialog (`editSeriesVisibility()`) whose checkbox list is built from the live
    series. Ticking everything stores NULL rather than a frozen list, so a series added later
    stays visible instead of silently vanishing from his board. NULL is also what every board
    predating the column keeps, so nothing changed underneath an existing client.
  - Chips for a held-back series render `.held` (dashed + dimmed) for the admin, so the board
    shows at a glance what the client is not getting.
  - `render()` self-heals a filter pointing at a vanished series, never leaves a non-admin on
    the `''` (untagged) view, and `setSeries()` clamps an out-of-range chip index to "Alle" —
    `undefined` would match no photo and blank the whole board.
- **Cold Cloudinary transforms were the reason board photos loaded slowly or not at all.**
  Nothing is pre-built, so the *first* request for a given width makes Cloudinary generate it
  from the full-size camera original — seconds of blank frame, and a timeout leaves an `<img>`
  permanently empty with no retry. Four defences, and they work together:
  1. `clientStorage` uploads with `eager` + `eager_async` for `CLIENT_GRID_WIDTHS`
     (`server.js:263`). Use `raw_transformation` built from the same string the frontend
     delivers — an eager derivative is only a cache hit when the transformation matches
     exactly, and that removes any guesswork about an omitted `c_` (Cloudinary defaults to
     `c_scale`) or parameter order. `eager_async` keeps the upload response off the
     derivative build, or the admin's upload dialog hangs per photo.
  2. `POST /api/admin/clients/:slug/warm-images` („Warm images“ in the admin bar) does the
     same via `uploader.explicit` for boards that predate the eager upload. Idempotent.
  3. The lightbox loads **progressively** — `showLbPhoto()` paints the 720px variant the grid
     already cached, then `lbSharpen()` swaps the sharp one in once it has loaded off-screen.
     Same trick as the public site's `_renderLightbox` (`public/index.html`). The identity
     guard is load-bearing: without it a slow fetch lands on a photo the client arrowed past.
  4. `retryImg()` gives a failed `<img>` exactly one more attempt with a throwaway query
     param, since the browser caches the failure. The budget resets per photo.
  Keep the width ladder short — grid 720 (×DPR → 1440), lightbox 1400, big 2600. Each distinct
  width is another derivative someone waits for, and 2600 is `cld()`'s own cap, so on a 2×
  screen the two lightbox modes resolve to one URL and toggling refetches nothing.
- **The lightbox has a client-facing „Grösser“ toggle** (`toggleBig()`, class `.big` on `#lb`),
  because the image loses height to two independent thieves: the reaction panel below it and
  the browser's own chrome. It collapses the panel to just the two reaction buttons — note,
  comment box, save row and admin line hide — *and* requests fullscreen. iOS Safari refuses
  fullscreen for anything but a `<video>`, so the collapse must be worth having on its own.
  `setBig()` holds state/class/label/persistence and is safe to call on open; anything needing
  a user gesture (the fullscreen request, the image swap) lives in `toggleBig()`. The choice
  persists in `localStorage` under `bp-lb-big` — guard every access, it throws in private mode.
  Big mode asks Cloudinary for 1900px instead of 1400 (`lbWidth()`), or fullscreen on a 1×
  display just upscales the smaller variant and reads as soft; keep it to fixed steps, since
  `cld()` already multiplies by DPR and each distinct width is another cached transform. The
  swap preloads off-screen and only then assigns `src`, so there is no blank frame. While
  fullscreen is active the keydown handler must let `Escape` through to the browser — closing
  the lightbox as well drops the client out of the photo he was looking at.
- **The lightbox arrows overlay the photograph**, so they carry their own scrim
  (`rgba(17,17,16,.62)` + light glyph). They were transparent with a light glyph and became
  invisible over a bright frame. Not `mix-blend-mode` — it detaches `position:fixed` on
  Android Chrome, the same trap the public site's nav is guarded against.
- **Lightbox navigation clamps at both ends and never wraps.** The header counts „Foto 3 von
  3“, so wrapping to the first candidate on the next press read as the board losing its place.
  The end arrow goes `disabled` (dimmed, still there) rather than hidden — a control that
  vanishes reads as a glitch. Swipe is wired on `.lb-body` for the same set, horizontal-only
  and past a threshold so it never steals a vertical drag or a pinch-zoom.
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
