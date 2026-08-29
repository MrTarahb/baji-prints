# CLAUDE.md

## Project

Baji Prints — fine art print atelier site for Bharat "Baji" Bhatia (Zürich). Portfolio + shop
(Stripe checkout) + workshops + admin CMS, live at `bharatbhatia.photography`.

## Work in progress — boards refactor (paused 2026-08-26)

A four-stage plan to give projects and workshops the same shape client boards have: a row in a
table, an overview list in `/admin`, and the page carrying its own admin controls. The full
plan, including schema and the decisions behind it, is at
`~/.claude/plans/federated-honking-bee.md` — **read it before continuing.**

**Done and deployed** (`9774252`, `791ceba`):
- `public/shared/chrome.{css,js}` — the main site's nav, footer, theme toggle, Portfolio
  dropdown and cursor, for standalone pages. See the header comment in chrome.css for why it is
  a second copy of what `public/index.html` carries inline, and what is deliberately not copied.
- Fountain City wears it: `Chrome.mount({ navInto: #topstack, floating: true, footer: false })` —
  toggle included, no `lockTheme`; see the dark mode entry below.
- `public/index.html` learned `/?cat=<slug>` so the dropdown can link back into a filter.
- **A chrome change does not reach a returning visitor by itself.** The origin sent no
  `Cache-Control` for `/shared/*`, so Cloudflare applied its 4-hour browser TTL and the fixed
  nav kept looking broken on a device that had loaded the page earlier the same day — new HTML
  asking for `lockTheme`, an old `chrome.js` that had never heard of it, near-white text back on
  the near-white scrim. `express.static`'s `setHeaders` now sends `no-cache` (revalidate, ETag →
  304) for anything under `public/shared/`, and the tags carry `?v=`. Bump it when a chrome
  change must land inside the hour for people already holding a copy — `?v=3` is the current
  one, for the `ch:theme` event.

**The "nav doesn't look right" bug is fixed** — it was never the width alignment the earlier
note suspected. Three separate things, all now closed:
1. **White on white in a private window.** A host page cannot pin the chrome's palette by
   redeclaring the `--ch-*` tokens in its own `:root` block: chrome.css's dark block is
   `:root:not([data-theme="light"])`, specificity (0,2,0) against a plain `:root`'s (0,1,0), so
   it wins regardless of source order. Anyone with a dark OS and no stored preference — which is
   every visitor in incognito — got near-white nav text on the near-white scrim. Pin with
   **`Chrome.mount({ lockTheme: 'light' })`** instead: it sets the `data-theme` attribute those
   selectors actually test, and never writes it to `localStorage`, so pinning one page does not
   change the visitor's choice for the rest of the site. It also drops the theme toggle — a
   pinned page offering one could only lie about what it does. (Fountain City no longer pins;
   `lockTheme` stays in the chrome for the next page that needs it.)
2. **Portfolio opened onto an empty box.** `render()` tears the nav down and rebuilds it when the
   `/api/content` labels arrive, which discarded a menu `loadCategories()` had already filled.
   The categories are held in a module variable and repainted by every `render()`, and the menu
   only opens once `.ch-dd-ready` says it has content.
3. It snapped open and shut. `.ch-dd-menu` hides with `visibility`, not `display:none`, so the
   fade can actually run.

**Dark mode landed on Fountain City**, so it carries the same day/night toggle as everything
else. What it took, and what to reuse for the next `/projects/<name>` page:
- The page's tokens gained the main site's two dark blocks — `@media (prefers-color-scheme: dark)
  { :root:not([data-theme="light"]) }` then `:root[data-theme="dark"]` — so the page turns with
  the attribute `chrome.js` writes. Same order, same guard, or an explicit light choice loses to
  a dark OS.
- **A gradient and a text-shadow cannot follow a colour token, so `--scrim` is an rgb triple**
  (`250,250,248` / `14,14,12`) composed as `rgba(var(--scrim),.97)`. The `#topstack` scrim and
  the halo behind the title, the tally and the nav links all read it.
- **Anything drawn as an SVG attribute has to be repainted by hand** — a Leaflet path takes its
  colour once. `kreisStyle()` and `ringStyle()` read `--ink`/`--geo` off the computed style, and
  `applyTheme()` pushes them onto the layers that already exist. Leaflet's own zoom buttons ship
  white with dark glyphs and needed the page's tokens too, as did the popup wrapper *and its
  tip* (a rotated square that otherwise stays a white beak).
- **The basemap turns with the page.** MapLibre swaps `positron` ⇄ `dark` in place via
  `getMaplibreMap().setStyle()` — same GL context, same centre and zoom, no blink and nothing
  above it rebuilt. The raster fallback has no equivalent, so that branch removes the layer and
  adds the other (`World_Light_Gray_Base` ⇄ `World_Dark_Gray_Base`, the same Esri service with
  one word swapped). Both paths are covered by the `node:vm` suite.
- **OpenFreeMap's dark style is not usable as shipped, and `DARK_TUNE` is the fix.** Measured
  against its own `rgb(12,12,12)` ground, a minor street is 1.10:1 and water 1.14:1 — invisible
  — while railways come out at 1.24:1, *brighter* than the roads: the same S-Bahn-diagram
  failure that got plain OSM tiles rejected, from the other side. Rather than fork 47 layers,
  `tuneBasemap()` repaints ~25 of them over the loaded style into a deliberate ladder: land,
  water and the quiet context just over it, then paths → minor → major → motorway, labels on
  top, railways pushed *below* the smallest street. The comments carry the measured ratio for
  each rung — keep them if you retune, they are the spec. Water is the one exception, kept
  low-contrast but unmistakably cool: it is a shape, not a line, and in Zürich the lake and the
  Limmat are the orientation. Positron is left alone.
- **A dark map is dark GREY paper, not black paper — and that took two passes to get right.**
  The first ladder kept the land near the page's own `#0E0E0C` (`#1A1A18`) and lifted only the
  lines: minor streets went 1.10 → 1.79:1, a big relative gain that was still unreadable on a
  phone outdoors, which is the only place this map is ever used. The land is what gives every
  line above it somewhere to go, so blackening it squeezes the whole ladder into a range no
  screen resolves in daylight. Land is now `#22221F`, minor streets 2.95:1, major 4.28:1,
  motorways 5.22:1 (trimmed to stay under the fountains' terracotta, 6.36:1 in dark — a motorway must
  not be as loud as the subject), street labels 11.45:1. **Retune from the land first and let
  the rungs follow; brightening lines against a black ground is the move that already failed.**
  `--map-land` carries the same value in CSS so the pre-tile frame is the colour the tiles
  settle on.
- **The tuning hangs off `styledata`, and `tunedStyle` is what stops it looping** — each
  `setPaintProperty` fires `styledata` again. The first pass claims the style url, re-entrant
  passes return at the top, and `applyTheme()` clears the claim before a swap. A layer upstream
  renames or drops is skipped, not thrown on.
- **Readiness for that pass is `getLayer('background')`, never `isStyleLoaded()`.** MapLibre's
  "style loaded" also waits for every source cache and the sprite — i.e. for tiles — and tiles
  arriving fire `sourcedata`, not `styledata`. Gating on it meant the single `styledata` a page
  load delivers was always rejected and *none* of the ladder was ever painted: the map shipped
  as upstream's own `rgb(12,12,12)` ground under 1.10:1 streets and `rgba(80,78,78)` labels.
  That reads exactly like a tuning problem, and it was a guard that never opened — measure a
  suspect dark map against the values in `DARK_TUNE` before retuning it.
- **The Kreis 1 outline is BRIGHTER in dark, not dimmer, and two earlier values got that
  backwards.** Both were chosen to land on a rung of the road ladder — `.26` (2.21:1 over the
  tuned land), then `.42` (3.61:1) — but a partly transparent white over `#22221F` composites to
  a literal grey (`rgb(88,87,84)` and `rgb(121,120,117)`), and a grey dashed line on grey land
  reads as an artefact rather than a boundary. It is `.8` / `rgb(199,198,195)` / 9.33:1 now,
  which is white. That is deliberately **above** the fountains (6.36) and the motorways (5.22) —
  the one place this page breaks its own ladder. Contrast ratio measures legibility, not visual
  weight, and a 1.5px line dashed `5 4` covers a sliver of the area a 13px filled disc does.
  Turn this alpha down before touching `DARK_TUNE` if it ever does compete.
- **Both marker rings are `--ink`, never `--bg`** — the fountain disc (`.fmark`) and your own position
  dot (`.me-dot`). A ring separates a marker from the map by *opposing* the ground, not by
  matching it: `--bg` gave a white ring on the light basemap's near-white land, where the disc
  lost its edge, and a near-black ring on dark land only a shade lighter. `--ink` flips with the
  theme by itself, so it stays one declaration per marker. `box-sizing` is `border-box` globally,
  so the ring eats into the 13px rather than growing it and the icon still matches its
  `iconSize` and anchor.
- **`--pink` is overridden in dark, and saturation is what earns its visibility.** The page
  terracotta `#C8907A` was mixed against a near-white ground; over the tuned `#22221F` land it
  falls to 5.87:1, barely clear of a motorway at 5.22. Dark uses `#E38F63` — 6.36:1, and
  saturation 43% → 56%. The chroma is the half that does the work: the basemap either side of
  a fountain is a desaturated grey-brown, so a 13px disc separates from it on hue faster than
  on luminance, and that is also what keeps the discs distinct from the near-neutral Kreis
  dashes now that those are brighter than the discs. **Hover goes brighter in dark, not
  darker** — `--pink-d` darkens against the light page to gain contrast, and the same move on
  dark land would lose it, so it is `#F2AE88` (8.50:1) there. Both dark blocks carry the pair;
  they must stay in step like every other token.
- **The two styles must show the same city, and `DARK_PLAN` / `LIGHT_PLAN` are how that is
  enforced.** Dark and light are two people's cartography, not one style in two palettes, and
  left alone they disagree about what a map of Zürich *contains* — that is a different problem
  from the contrast ladder above, and it produced a run of "why is this only in dark/light"
  reports. One rule now: whatever a visitor can read in one theme they can read in the other,
  and where the two disagreed the **quieter** answer won, because a label that is not a fountain
  or the street one stands on competes with the subject. What each plan settles:
  - *Dark hides* the one-way arrows (a chevron every 200px, and positron draws none), the
    motorway `ref` labels (positron says the same thing in a shield, also hidden), and
    `place_other` (hamlets and neighbourhoods, which positron does not label).
  - *Light hides* the three road-shield layers — the white lozenges stamping "3", "17", "A3W" —
    `water_name_point_label`, and the `airport` label (dark has no aerodrome layer at all).
  - *Dark holds `highway_name_other` to z15* and gets a **cloned** major-road name layer for
    z12.2–15, which is positron's arrangement: 548 street names against positron's 67 at the
    zoom where the whole city is on screen was the largest single difference between the two.
  - *Light caps its place labels* where dark caps them (suburbs z15, cities z14) and is filtered
    to suburbs only — `label_other` is "not a city/town/village/state/country", which over
    Zürich means twelve suburbs *and* fourteen quarters.
  - *Both gain a clone* so parks match: positron reads the `park` source-layer, dark reads
    `landuse` class=park, and each now draws both. Over Zürich both are empty today; the clone
    exists so the day someone tags the Platzspitz either way, both themes draw it.
- **`water_name_point_label` is hidden outright, and nothing is lost by it.** Zürich maps a good
  many fountains as named water *areas*, so that lake layer was captioning three of several
  hundred (Geisterbrunnen, Münsterhofbrunnen, Zentralhofbrunnen) and saying nothing about the
  rest — which reads as those three mattering. „Zürichsee" is a **LineString** feature and is
  drawn by the line-label layer in both themes, so the lake keeps its name either way.
- **A plan is applied in a fixed order — paint, filter, zoom, add, hide — and two steps depend
  on it.** `add` clones AFTER paint, so a clone inherits the tuned colours (the river labels come
  out the lake's blue for free), and BEFORE hide, so cloning off a layer that is about to be
  hidden still yields a visible one.
- **`cloneLayer()` is how a style gets content the other one has.** It copies a layer already in
  the style and overrides only the source-layer, filter and zoom range, so the source, fonts and
  `text-field` expression come from upstream and there is nothing here to keep in step with
  them. Filters are **wrapped** in an `['all', …]`, never replaced, for the same reason.
- **Differences deliberately left**, all of them outside z12–20 over one city: country and state
  labels, `boundary_disputed`, and positron's separate motorway tunnel/bridge layers (it draws
  those roads in their own layers and excludes them from the main one; dark draws all three in
  the main one — the same roads either way).
- The node:vm suite runs `tuneBasemap()` against the **real** style JSON fetched from
  OpenFreeMap, with `isStyleLoaded()` answering false throughout — a stub that answered true is
  what let the guard bug ship. It asserts every layer either plan names still exists upstream,
  and then reduces both styles to what they actually draw (source-layer per visible layer, minus
  the exclusions above) and fails if **anything is drawn in only one theme**. That last check is
  the one that keeps this from drifting back.
- **The layer differences were established from the TILES, not by reading the styles**, and that
  is the method to repeat. `tiles.openfreemap.org/planet` stops at z14, so z15–20 overzoom the
  same data: the z14 tile over Zürich holds 27 place points (one city, twelve suburbs, fourteen
  quarters), 548 street names of which only 67 are major roads, 14 water names of which
  „Zürichsee" is the only line, two `park` features which are both *points* and so fall outside
  positron's polygon-only filter, no `landuse` class=park at all, and 9,207 POIs plus 303 house
  numbers neither style touches. Reading the style JSON alone would have got the park layers and
  the water names wrong in both directions.
- **`chrome.js` fires `ch:theme` on `document` from `paintTheme()`** (detail `{dark}`), which is
  how a host page learns about a toggle it does not own, and it now also follows the OS while
  nothing is stored — a system switch with the page open repaints it. `Chrome.isDark()` is
  exported as the single reader; asking `matchMedia` separately answers differently for someone
  whose stored choice contradicts their OS.
- The first `ch:theme` fires during `mount()`, before `initMap()`, hence the map guard inside
  `applyTheme()`.
- Still deliberate: the scrim is much heavier than the main site's (`.97` against the hero nav's
  `rgba(17,17,16,.35)`) — a dial worth turning if asked, not a bug.

**Stage 2 (projects) — built, in the working tree** (first slice; not yet its own deploy):
- **`projects` table** — one row per `/projects/<slug>` page: `slug` (unique), `type`, `title`,
  `eyebrow`, `intro`, `published`, `sort_order`. The row is the *envelope* — routing, the
  `/admin` overview, publish state and the page's copy — while a project's bespoke data (the
  `fountains` table for the map) stays in its own table. `type` tells `/projects/:slug` which
  template to serve; today only `map` is handled.
- **Fountain City is seeded as the first row**, and its copy was migrated off the old
  `content.fountain_*` keys onto the row — those keys are read across once in `initDB()` (so an
  admin's edits survive), written to the row, then **deleted from `content`**. They are also
  gone from the content seed defaults, so nothing re-creates them. The main site never read
  them, so this touched nothing public.
- **`GET /projects/:slug`** looks the slug up and serves `public/projects/<slug>/index.html`;
  the file path is built from the *row* slug, never the request param. **`published` drives
  noindex only** — an unpublished project is still reachable by its URL (Fountain City's state),
  it just gets `X-Robots-Tag: noindex`. The old singular `/project/fountaincity` 301 stays.
- **`GET /api/admin/projects`** (overview) and **`PUT /api/admin/projects/:id`** (partial update,
  built the `client_photos` way — `$${n}`, fixed column allow-list). The `/admin` **Projects**
  panel lists projects and carries the publish switch; copy is still edited inline on the page.
- Verified by lifting each handler against a stub `pool` (the SQL-shape / noindex / copy-shaping
  checks) and a `node:vm` run of the page script — the method these routes' comments cite.
- **Not done in this slice:** creating a *new* project from `/admin`. Each `type` still needs a
  hand-built page template (the map is the only one), so there is nothing generic to spin up yet.

**Stage 3 (workshops) — built, in the working tree** (the *standalone-page* variant — the
workshop is its own page now, `public/workshop/index.html`, not a section of the main SPA):
- **`workshops` table** — one row per `/workshop/<slug>` page (`slug`, `title`, `published`,
  `sort_order`). **`workshop_overrides` (workshop_id, key, value)** holds per-workshop copy: the
  hand-written `content.workshop_*` strings stay the shared default and are **never overwritten**
  (the hard constraint), and a row overrides only the keys it wants to differ on. `workshop_dates`
  and `workshop_photos` gained a `workshop_id`; the seed backfills the pre-refactor rows onto the
  first workshop (`photo-to-print`, seeded `published=true` because `/workshops` was indexed).
- **`workshopCopy(id)`** merges overrides over the content defaults; a stored `''` stays `''`
  (deliberately empty), a missing key falls back — the same distinction the project copy draws.
- **`GET /api/workshops/:slug`** returns merged copy + this workshop's open upcoming dates
  (with `spots_left`) + photos + the admin flag, in one request. **`GET /workshop/:slug`** serves
  the one standalone template (it reads its slug from the path); `published` drives noindex.
  **`/workshops` 301s** to the first published workshop and the sitemap lists `/workshop/<slug>`
  in its place, so the old indexed URL keeps its rank. Admin: `GET /api/admin/workshops`,
  `PUT /api/admin/workshops/:id` (title/published, `$${n}` allow-list), `PUT …/:id/copy` (one key;
  saving the site default *deletes* the override so the table holds only genuine differences); the
  existing `workshop-dates`/`workshop-photos` routes now carry `workshop_id`.
- **The page carries its own inline admin** (copy per-field, date CRUD, photo add/delete) like the
  fountain map, so the **old `/admin` workshop panel was retired** — `/admin` now has a *Workshops
  overview* (link + publish switch) beside Projects. The workshop page and its wiring were removed
  from `public/index.html` (markup, `.ws-*`/`#workshop-page` CSS, `loadWorkshopData`, the
  `/workshops`↔`workshop` routing). **Booking stays disabled** (the button is inert); the schema
  is scoped and ready but nothing re-enables it.
- **Now-unused, left in place:** the pre-refactor global `GET /api/workshops` (all open dates) and
  `GET /api/workshop-photos` (all photos) — nothing calls them since the SPA page is gone; harmless,
  removable later.
- Verified by lifting every handler against a stub `pool` (copy merge, override upsert-vs-reset,
  `$${n}` shape, the data route, the `/workshop/:slug` dispatch) and a `node:vm` run of the page.
- **Not done:** creating a *new* workshop from `/admin` (the schema supports it; there's no
  add-workshop UI yet), and slug renaming (Stage 4 — the `PUT` deliberately omits `slug`).

**Not started:** Stage 4 (slug renaming — needs an old-slug→new redirect, for both projects and
workshops). **Hard constraint still standing: never overwrite the hand-written `workshop_*` values
in `content`** — they are the shared fallback the overrides table sits on top of.

Delete this section once the refactor lands.

## Commands

No test suite, no linter, no build step. Verification before committing is manual:

```bash
node --check server.js
# For each HTML SPA (public/index, admin, client, projects/fountaincity,
# workshop): extract the <script> block to a temp file and `node --check` it,
# assert the <style> block's { } counts match, and assert the file contains no
# control characters (see below). Server route/handler logic is checked by
# lifting a handler against a stub `pool` that records the SQL (see the boards
# refactor's projects/workshops tests); render logic by a node:vm run of a page.
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

Six tracked source files. Everything else is `node_modules` / config.

| File | ~Lines | Role |
|---|---|---|
| `server.js` | 3,600 | Entire Express app: schema init/migrations/seeds, all API routes, Stripe webhook, email, SSR meta injection |
| `public/index.html` | 4,200 | Public site — vanilla-JS SPA, inline `<style>` + `<script>`, no framework, no bundler |
| `public/admin/index.html` | 2,150 | Admin panel — separate vanilla-JS SPA |
| `public/client/index.html` | 1,075 | Private client proofing boards — separate vanilla-JS SPA, German UI |
| `public/projects/fountaincity/index.html` | 330 | Fountain City — public Leaflet map of Zürich's fountains, separate vanilla-JS SPA |
| `public/workshop/index.html` | 440 | Workshop — standalone `/workshop/<slug>` page, data-driven, inline admin, separate vanilla-JS SPA |

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

**A placeholder built into a template literal needs `$${n}`, not `${n}`, and one missing `$`
does not fail loudly.** Both partial-update routes assemble their SQL this way. `PUT
/api/admin/fountains/:id` shipped with the `$` missing on all four and ran `UPDATE fountains SET
lat=1, lng=2, name=3, note=4 WHERE id=5` — integer *literals*, so it edited whichever row had
id 5 rather than the one asked for, moved it to (1, 2) in the Gulf of Guinea, and stored the
strings '3' and '4' (PostgreSQL assignment-casts a number into a text column without
complaint). It returned 200 and the page toasted "Saved". Nothing about it looked wrong from
the outside; it surfaced as "the note I typed isn't on the fountain". `client_photos` at
`server.js:3456` is the correct pattern — copy from there, and check the built statement rather
than the code that builds it: lifting the handler out of `server.js` and running it against a
stub `pool` that prints the SQL takes about thirty lines and answers this exactly.

**Route order.** Literal paths before `/:id` params, always (e.g. `/api/admin/prints/reorder`
before `/api/admin/prints/:id`).

**Webhook idempotency.** Order fulfilment claims the pending→paid transition with an atomic
`UPDATE … WHERE status='pending' RETURNING`. Any duplicate delivery sees zero rows and exits.
Don't weaken this — it guards edition counters and duplicate emails.

**Cloudinary URL builder is quadruplicated.** `cldUrl()` in `server.js:286`, `cld()` in
`public/index.html:2716`, `cld()` in `public/admin/index.html:749`, `cld()` in
`public/projects/fountaincity/index.html`. Keep them in sync. Use `q_auto:good`, never bare
`q_auto` (bands dark gradients when `f_auto` serves AVIF).

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

**The custom cursor is site-wide, and it is a fifth copy to keep in step.** The main site
replaces the OS pointer with a 10px white disc (`#cur`, `mix-blend-mode:difference`) that swells
to 48px over anything actionable; `public/client/index.html` and
`public/projects/fountaincity/index.html` carry the same dot, driven by the same delegated
`mouseover`/`mouseout` pair. Only `CUR_TARGETS` differs per page. `/admin` deliberately does
**not** get it — it is a tool, and its drag-to-reorder needs real `grab`/`grabbing` cursors.
- **Delegation on `document`, never a `querySelectorAll` snapshot.** Every one of these pages
  repaints wholesale (`render()` on the board, the marker layer on the map), so a snapshot taken
  at load covers nothing a second later. `mouseover`/`mouseout` because `mouseenter`/`mouseleave`
  don't bubble, plus a tracked "currently matched" element so crossing a child doesn't flicker.
- **The two newer pages gate on `(hover:hover) and (pointer:fine)`, not the main site's
  `max-width:480px`,** and build the element only when that query matches. A width breakpoint
  leaves a touch tablet carrying a `mix-blend-mode` element it can never use — and blend modes
  detach `position:fixed` on Android Chrome, which on the fountain page is the whole layout.
- **Anything clickable that isn't an `<a>` or `<button>` has to be named twice** — once in the
  `cursor:none !important` list so the OS pointer doesn't show *under* the dot, once in
  `CUR_TARGETS` so the dot swells on it. `.card`, `.chip` and `.fname` on the board; `.fmark` on
  the map. Leaflet needs `.leaflet-container *` in the first list: its `grab`/`grabbing` rules
  outrank a bare `body` selector, so without it the map shows an OS cursor and the dot at once.

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
- **Deleting a whole board is `DELETE /api/admin/clients/:slug`, and it demands the slug back**
  in `confirm_slug`. There is no undo and nothing archives it, so a request aimed at the wrong
  board by a mistyped URL deletes nothing rather than the wrong client. The dialog on the board
  asks for the slug too, but the server's check is the guard — the dialog is a courtesy. The
  route follows the same cascade rule as the room and spot deletes: collect the Cloudinary ids
  *before* the delete, destroy them non-fatally after. A client still holding a session for that
  slug needs no cleanup; the board route looks the slug up per request and now finds nothing.
  Deleting the *last* board lets `initDB()`'s seed recreate `schuetzdental` on the next deploy —
  the seed gates on `COUNT(*) = 0`, so that only bites when none are left.
- **Management is inline on the board**, not in `/admin` — opening `/client/<slug>` while
  logged in as admin reveals the add/edit controls. `/admin` only links to boards and shows an
  unseen-feedback count.
- Nothing about a board is public: excluded in `robots.txt`, `X-Robots-Tag: noindex` on the
  route, absent from `sitemap.xml`, and the session probe returns an identical response for an
  unknown slug, a locked board, and a logged-out visitor so a guessed URL confirms nothing.
  - **The one exception is an `unknown: true` flag added only for a requester who already holds
    an admin session.** To everyone else the response stays byte-identical, so the property
    above is intact. It exists because the login route answers `Falsches Passwort` to a wrong
    password *and* to a slug that does not exist — deliberately indistinguishable — which left
    the admin testing his own board unable to tell a typo in the URL from a broken password.
    That cost a real debugging session. Keep the flag admin-gated; never widen it.
  - **A password is trimmed on both sides of the wire, or on neither.** `ask()` trims what the
    admin types, so the stored hash is of the trimmed string; the gate trims too. A gate sending
    the raw value rejects a password with a stray space forever, and the error it shows —
    "wrong password" — points nowhere near the cause.
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
  Big mode asks Cloudinary for 2600px instead of 1400 (`lbWidth()`), or fullscreen on a 1×
  display just upscales the smaller variant and reads as soft; keep it to fixed steps, since
  `cld()` already multiplies by DPR and each distinct width is another cached transform. The
  swap preloads off-screen and only then assigns `src`, so there is no blank frame. While
  fullscreen is active the keydown handler must let `Escape` through to the browser — closing
  the lightbox as well drops the client out of the photo he was looking at.
  - **The cursor and big mode both have to follow the browser out of fullscreen** — `onFsChange()`,
    bound to `fullscreenchange` and `webkitfullscreenchange`. A fullscreen element renders alone,
    nothing outside its subtree painted, while `cursor:none` still applies *inside* it: the dot
    living on `<body>` disappeared and the OS pointer stayed hidden, so „Grösser“ left the client
    with no pointer at all until he pressed Esc. The dot is reparented into the fullscreen element
    and back onto `<body>` afterwards (`cursorEl`, null on a touch device). And because the browser
    claims Esc for itself, escaping used to land him on a windowed page still in big mode, panel
    collapsed, the button his only way back — so leaving fullscreen now leaves big mode with it,
    **only while the lightbox is still open**: `closeLb()` calls `fsExit()` too, and syncing there
    would wipe the remembered `bp-lb-big` on the way out.
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
- **Every card in one grid renders at the SAME rectangle, and layout never reads the individual
  file's pixels.** The shape is `gridBox()`'s **median** ratio of the photos sharing the box;
  each card carries `--ar` (that median) and `--sar` (its square root) and the CSS does
  `flex: 0 1 calc(var(--sar) * var(--cell))` with `--cell: 404px` on `.grid`, so width =
  √t × cell, height = cell ÷ √t, area = cell². `object-fit: cover` trims each frame into the
  shared box; the lightbox always shows it whole, so nothing is judged on a trimmed image.
  **Three sizing rules were tried here and the first two are bugs to not reintroduce:**
  - *Justified rows* (`flex-grow: ar` + an `::after` spacer) — a row holding one photo
    stretched it to the full container while the next row's kept its natural size.
  - *Equal height*, then *equal area* — each fixed the previous one and still let a 1.41:1 frame
    land beside a 1.50:1 one at a visibly different width. Two frames off the same camera differ
    by a percent or two, and any rule that honours the real ratio puts that difference on the
    page as one photo being wider, or taller, than its neighbour.

  The client is choosing photographs; a layout that makes one of them bigger has voted. Hence a
  *normalised* ratio. The median (geometric mean of the middles for an even count) splits the
  trim evenly and stops one panorama from dragging the box: 1.41 and 1.50 both settle on 1.45,
  giving up ~1.5% off opposite edges. **A frame more than `MAX_TRIM` (10%) off the box gets
  `.card-img.fit` → `object-fit: contain`** — whole, on the box's `--bg2` ground, in the same
  rectangle — because forcing a panorama into a 3:2 box is a re-crop, not a trim. Portraits get
  their own box for the same reason: same area, turned 90°.

  `width` / `height` are captured from Cloudinary at upload. Older rows without them lay out at
  the 3:2 fallback, and `adjustRatio()` writes the measured size back onto the **photo object**
  and re-`render()`s (debounced) rather than patching the one card — the box is a median over
  the grid, so a card corrected in place would give that grid two rectangles again. It
  terminates: once `width`/`height` are set, `cardHtml` stops attaching the handler. Each card
  is also capped at `max-width: min(calc(var(--ar) * 68vh), 100%)` — without the `vh` term a
  portrait on a short viewport resolves taller than the screen. On mobile the cards go full width
  (`flex-basis:100%`), and `min-width` must stay `0` there, because `min-width` beats
  `max-width` and would defeat that cap.
- Uploads go to Cloudinary `baji-clients/<slug>/` via `clientStorage`, whose folder is resolved
  per request from `req.uploadClientSlug` — the route must set that *before* multer runs.
- Deleting a room or spot cascades in Postgres, so the route collects `public_id`s **before**
  the delete and destroys the Cloudinary assets afterward, or they orphan.
- **Renaming a live column** needs a guard — plain `ALTER TABLE … RENAME` is not idempotent and
  would throw on the next deploy, and a throw in `initDB()` exits the process and takes the
  whole site down. The `caption` → `note` migration in `initDB()` is the pattern: a `DO $$`
  block that renames only if the old column exists *and* the new one does not, followed by
  `ADD COLUMN IF NOT EXISTS` so fresh databases get it too.

### Fountain City (`/projects/fountaincity`)

A public map of Zürich's public fountains — the first of what the URL implies will be several
`/projects/<name>` pages. One table (`fountains`), one page,
`public/projects/fountaincity/index.html`. A fountain is a coordinate, an optional `name`, an
optional `note` (Bharat's own words, shown to everyone) and at most one photograph.

- **The admin bar spans the FOOT of the screen, not the top stack.** The top is already carrying
  the scrim, the nav, the eyebrow, the title and the tally; a second dark bar in there pushed the
  map's first usable row a third of the way down. Everything Leaflet parks in the bottom corners
  — the zoom control, `Locate`, and the attribution the tiles' licence requires — is lifted clear
  by `--abh`, which `syncAdminBar()` **measures** rather than assumes: the bar's buttons wrap onto
  a second line on a narrow phone, and it re-measures on `resize` and once more on the next frame
  (the first read lands before the webfont settles). It is `0px` for everyone who is not the
  admin, so nothing about the public page moves.
- **Public page, admin controls inline** — the same shape as the client boards, minus the gate.
  `GET /api/fountains` returns the rows plus an `admin` flag telling the page whether *this*
  visitor may edit; the fountain rows themselves are public, so there is nothing to withhold
  from the payload the way a client board withholds `public_id`. Log in at `/admin`, then open
  the map and the admin bar appears.
- **It is `noindex` for now, not private, and the `published` flag on its project row is what
  controls that** (stage 2). The page is reachable by anyone with the URL but is linked from
  nowhere and absent from `sitemap.xml`; while `published` is false the `/projects/:slug` route
  sends `X-Robots-Tag: noindex`. There is no longer a `<meta name="robots">` in the page — a
  hardcoded one would override the flag and keep the page out of search even after publishing.
  That is a deliberate not-finished-yet state, *not* the client boards' privacy posture. **To
  ship it: hit Publish in the `/admin` Projects panel and add a `sitemap.xml` entry** — the
  sitemap step is still manual.
- **The basemap is vector (MapLibre + OpenFreeMap Positron), and three earlier choices were
  tried and rejected.** In order: CARTO Positron looked right but now stamps an "API key
  required" watermark over unkeyed requests, and every other *pre-styled raster* basemap
  (Stadia, Mapbox, CARTO with an account) wants a key too. Plain OSM tiles desaturated with a
  CSS filter came next and were worse in a way no filter can fix — OSM renders railways and
  ferry routes as first-class features, so the map read as an S-Bahn and Seeschiff diagram with
  the fountains lost on top. Esri's Light Gray Canvas fixed that (a *canvas* basemap is the
  right category: a backdrop for data, no transit at all) but stops rendering at zoom 16, so
  the deepest steps upscale and look soft. Vector tiles end the whole line of argument: the
  browser draws the map from geometry, so it is sharp at every zoom and every pixel density and
  nothing is ever a stretched picture. OpenFreeMap serves Positron with no key and no signup.
  - **`addBasemap()` keeps the Esri raster as a live fallback, and that is not decoration.**
    MapLibre is two more scripts off a CDN and it needs WebGL; if either is unavailable the
    page must still get a map rather than a blank grey rectangle. `hasWebGL()` wraps
    `getContext` in try/catch because some privacy modes throw instead of returning null. The
    fallback keeps `detectRetina` (1x tiles stretched across a 2x screen are the *other* source
    of softness) and `maxNativeZoom: 16` (note `{y}` precedes `{x}` in the Esri URL). Both
    branches are covered by the `node:vm` suite — don't let the fallback rot.
  - Attribution is set on the Leaflet layer by hand: inside the bridge, MapLibre's own
    attribution control never renders, and OpenFreeMap/OpenMapTiles/OSM all require it.
- **Leaflet 1.9.4 from cdnjs**, with MapLibre GL and `@maplibre/maplibre-gl-leaflet` from unpkg.
  The bridge mounts the vector basemap as a Leaflet layer, so every marker, popup and handler
  on the page stays plain Leaflet and none of it had to change when the basemap did.
- **Desktop zoom is continuous, and Leaflet's wheel handler is off** (`initWheelZoom()`). Leaflet
  debounces wheel events and then steps by whole levels, which on a vector basemap throws away
  the one thing vector tiles are for — every fractional zoom is drawn from geometry at full
  sharpness, so there is nothing to snap to. A wheel event moves a *target* zoom and a rAF loop
  eases the map toward it, anchored on the pointer.
  - **The easing is not decoration.** A trackpad already sends a stream of small deltas, but a
    mouse notch arrives as ONE event, so the distance has to be travelled or it lands as the same
    jump Leaflet produced. `WHEEL_EASE` covers that fraction of what is left each frame; a second
    notch mid-flight just extends the target.
  - `zoomSnap` goes to 0 for the duration and is handed back on the way out — the same dance the
    held-tap drag does, so the buttons and `fitBounds` keep landing on whole levels and the next
    press of `+` re-aligns a fractional zoom to the grid by itself. The ease also lets go on
    `mousedown`, or a `+`/`-` press would fight it.
  - **The raster fallback keeps Leaflet's stepped handler** — it upscales anything between whole
    levels, so a smooth zoom there is a smoothly blurring picture. `initWheelZoom()` returns
    early unless the basemap is the MapLibre one.
  - `deltaMode` is normalised by hand (1 = lines, 2 = pages) and capped per event, and a
    ctrl-wheel — which is how a browser reports a trackpad pinch — gets its own, much higher rate.
- **The gesture is double-tap-and-DRAG: tap, lift, tap again and hold, then slide the finger
  DOWN to zoom in and UP to zoom out, continuously** (`initTapZoom()`). Lifting the second tap
  without moving is the plain double tap and steps in one level; a two-finger tap steps out.
  All of it is hand-rolled.
  - **The second tap is armed at its `touchstart`, not judged at its `touchend`,** because
    holding it is a gesture in its own right. `arm()` anchors on the tapped container point,
    switches `map.options.zoomSnap` to 0 for the duration (fractional zoom is what makes the
    drag smooth; everything else on the page stays on whole levels) and calls
    `map.dragging.disable()` — Leaflet's drag handler already holds that contact and would pan
    the map out from under the zoom. `disarm()` restores both, and `touchcancel` must call it
    too or the map is left unpannable at a fractional zoom.
  - **The drag engages only past `DRAG_MIN`, and re-baselines when it does**, or the zoom jumps
    by that much the instant it takes over. Under that threshold the lift is still a double tap.
  - Applies at most once per frame via `requestAnimationFrame`: every `setZoomAround` resyncs the
    MapLibre basemap, and `touchmove` fires far more often than the screen repaints.
  - Lands on a whole zoom level when the finger lifts — the raster fallback upscales anything
    else, and the rest of the page assumes integer zooms.
- **Double tap and two-finger tap were the first shape of this, and the detection is shared.**
  Leaflet dropped its double-tap emulation in 1.8 on the assumption that the browser fires
  `dblclick` itself, but the container carries `touch-action:none` — which is what makes
  dragging and pinching work — and under it a phone browser never synthesises one, so on
  mobile a double tap did nothing at all. The handlers read `touchstart`/`touchmove`/`touchend`
  directly and `setZoomAround` the tapped point. Leaflet's own `doubleClickZoom` stays for the
  mouse — it is disabled on `touchstart` and re-enabled on `mousedown`, so exactly one of the
  two ever fires.
  - **Every contact is tracked by its own `identifier`; never by `touches.length`.** A fast
    double tap does *not* arrive as two clean, separated single-touch sequences — the first
    contact's `touchend` can be delivered *after* the second contact's `touchstart`, so the page
    briefly sees two touch points and then a `touchend` still reporting a finger down. Two
    versions keyed off `touches.length` and both threw the second tap away; on a real phone the
    log read `start x1 / tap gap - / start x1` and then nothing, with an occasional `start x2`.
    The gap between taps goes **negative** when the lift lands late, and that is a double tap by
    any reading, so it is clamped to 0 rather than rejected.
  - **Two touch points are two FINGERS only if they are `PAIR_MIN` apart.** The phantom pair a
    fast double tap produces is one thumb in one place; treating any second point as a pinch is
    what stopped the gesture from ever completing.
  - **`DBL_MS` is measured from one tap LIFTING to the next one LANDING**, the way a phone
    measures it. Measuring instead to the second tap's own *lift* charges the window for however
    long the finger rests on the glass; that shipped first, and an unhurried double tap — 220ms
    between taps, ~110ms of contact each — silently missed a 300ms budget, so the gesture did
    nothing at all. Keep the tap's own duration as a separate cap (`TAP_MAX`, a long press).
  - **There are two independent detection paths and one guard between them.** Whether a phone
    browser synthesises `dblclick` from a double tap is precisely what cannot be verified from
    the working tree, so the page also takes a `dblclick` if one arrives, ignoring it when
    Leaflet's handler is enabled (a mouse) or when the touch path zoomed in the last 800ms. The
    guard is on the `dblclick` path only — a global cooldown in `zoomAt()` would block the
    second of two double taps in a row, which is how anyone zooms in twice.
  - Three more guards are load-bearing: a finger that travels past `TAP_SLOP` is a pan and not a
    tap; a two-finger gesture is checked on its **spread** as well as its midpoint, because a
    pinch's midpoint barely moves; and the step is clamped to min/max *before* `setZoomAround`,
    which otherwise offsets the centre by an unclamped scale and slides the map sideways at
    either zoom limit.
  - **`?taplog=1` prints what the browser actually fired** into a corner overlay (`tapLog()`,
    inert without the param). The gesture can only be tested on a real phone, and this is how
    the phone reports back.
  - **The admin's tap-to-place had to become deferred** (`queueAdd()`), because placing a
    fountain and zooming start with the same tap: the Add dialog waits `DBL_MS` to see whether
    a second tap is coming, and a recognised gesture calls `blockAdd()`. The block *window*
    (not just cancelling the timer) is the part to keep — the browser delivers the second tap's
    synthetic `click` **after** the gesture has already been recognised, so cancelling alone
    lets the dialog open on every zoom.
- **A fountain is a `divIcon` disc, not a pin.** A pin's point sits below its own graphic, so a
  few hundred of them read as a pincushion; a disc marks its exact coordinate at its centre.
- **Coordinates are parsed, never trusted** — on the page by `parseLatLng()`, which accepts what
  a map app hands you on copy (`47.3769, 8.5417`, or space/semicolon separated) and returns
  `null` rather than a half-parsed pair, and again on the server by `parseCoord()`. A typo that
  silently became `0` would drop a fountain in the Gulf of Guinea.
- **`render()` repaints the whole layer group from the `fountains` array** rather than mutating
  markers in place, so there is one source of truth. `fitBounds` runs only on load: refitting
  after each add would yank the map out from under the admin, and a new fountain pans the view
  only when it lands off-screen.
- **A fountain holds one photograph, on the row itself** (`image_url`, `image_public_id`,
  `image_width`, `image_height`) rather than in a `fountain_photos` table. One pin, one picture,
  one popup. If several per fountain are ever wanted that is a new table and a gallery in the
  popup — not more columns.
  - Uploads go to Cloudinary `baji-fountains/` via `fountainStorage`, eagerly building the two
    widths the page actually asks for (`FOUNTAIN_WIDTHS` = popup 640, full-size 1600). Keep the
    ladder to those two: each extra width is another derivative a visitor waits for on first
    view of a pin.
  - Replacing and removing both **destroy the previous asset**, non-fatally, and `DELETE
    /api/admin/fountains/:id` reads `image_public_id` in its `RETURNING` before the row is gone.
    This route does not leak the way the two known ones do — keep it that way.
  - The photograph is attached **after** the fountain row exists, in a second request, so a
    failed upload costs the photo and not the coordinate. Retry from the pin's own Add photo
    button.
  - The file picker is opened **straight from the click**, never from behind a modal's OK — the
    same mobile trap the client board's uploads document.
- **`PUT /api/admin/fountains/:id` writes only the body keys actually present**, so editing the
  name can't blank the note; column names come from a fixed list, never the request. Coordinates
  are the exception — they are validated as a pair, since a lone `lat` is never meaningful.
- **`render()` rebuilds every marker, which silently closes an open popup**, so it indexes them
  by id (`markerById`) and every admin action ends `render(); reopen(id)`. Without the reopen,
  saving an edit drops you back to the bare map and reads as the pin having vanished.
- **The Kreis 1 outline is real published geometry, not a hand-drawn shape.**
  `kreis1.geojson` holds the Stadtkreis 1 polygon exactly as Stadt Zürich publishes it (WFS
  `geoportal/Stadtkreise`, layer `adm_stadtkreise_a`, `srsName=EPSG:4326` — the file records its
  source and retrieval date). 807 points, unsimplified: it is an administrative boundary, so it
  is copied rather than approximated. Refetch the same way to add the other eleven Kreise.
  - It lives in its own file rather than inline: 17KB of coordinates would swamp the page source
    and the extract-the-`<script>` verification step.
  - **Fetched by absolute path.** The page is served at `/projects/fountaincity` with no trailing
    slash, so a relative `kreis1.geojson` resolves against `/projects/` and 404s.
  - **`interactive: false` is load-bearing.** A Leaflet path swallows clicks that land on it, and
    the admin places fountains *by* clicking the map — an interactive polygon would make the
    whole of Kreis 1 the one place a pin could not be dropped.
  - Styled in ink, dashed and half-transparent, never the fountains' terracotta: the outline is
    context and must not read as content. A failed load is silent for visitors and a toast for
    the admin — the map is still a map without it.
- **Geolocation is the feature the project is actually for**: you are standing at the fountain,
  so the phone knows its coordinate better than you can read it off a map. A `Locate me` control
  (bottom-left, where a thumb already is) starts a `watchPosition`, and the admin bar's
  `+ Fountain here` opens the Add dialog prefilled with the current fix.
  - **`enableHighAccuracy: true` everywhere.** It is slower and costs battery, which is the
    right trade when the fix is about to become a fountain's permanent coordinate.
  - **The accuracy is shown, never hidden** — as a ring on the map at its true radius, and in
    the dialog as "accurate to about N m", with a warning past `ACCURACY_WARN` (25m, most of a
    city block). A loose fix is still worth saving when you are standing there; you just need to
    know to nudge the pin afterwards.
  - **`interactive: false` on the position dot and the accuracy ring**, and
    `L.DomEvent.disableClickPropagation` on the Locate button. All three exist for one reason:
    the admin places fountains BY clicking the map, so anything drawn on top that swallows a
    click becomes a dead zone, and a button that doesn't stop propagation opens the Add dialog
    every time it is pressed.
  - **Panning by hand stops the map chasing you** (`geo.follow = false` on `dragstart`) without
    stopping the watch — the dot keeps updating. Tapping the button again re-follows.
  - `addHere()` reuses a live fix under 30s old rather than requesting a new one, so adding
    several fountains on one walk doesn't wait for the GPS each time.
  - The nearest-fountain readout under the count is what makes this useful to a visitor rather
    than only to the admin: metres under a kilometre, then km.
- **The map IS the page.** `.map-wrap` is `position:fixed; inset:0`, and the admin bar and title
  float over it in `#topstack`. Anything less — a bordered map in a gutter, or a map that starts
  below the header — reads as a screenshot of a map rather than the map itself.
  - `#topstack` takes **no pointer events**; only `#adminbar` takes them back. That way the map
    can be panned straight through the title instead of the header being a dead strip across the
    top of it.
  - The header is a **scrim, not a bar**: a gradient from the page background to transparent, so
    the map keeps running underneath and fades out from under the text.
  - **Readability where the scrim has faded** comes from a light `text-shadow` halo on the
    eyebrow, title, tally and intro. `text-shadow`, never `mix-blend-mode` — blend modes detach
    `position:fixed` on Android Chrome, which is precisely what this whole layout rests on. The
    same reason `body` is `overflow:hidden` and `#topstack` is capped at `max-width:100vw`.
  - **On a phone the header steps aside once the map is used** (`leanOnUse()` sets `.lean`,
    collapsing the intro sentence; the title and tally stay). It binds a one-shot `pointerdown`
    on the map container rather than Leaflet's `movestart`/`zoomstart`, because those also fire
    for the programmatic `fitBounds` on load — which would collapse the sentence before anyone
    had a chance to read it.
  - **The collapse animates a grid track (1fr to 0fr), never a max-height.** A max-height has to
    be guessed, and the intro is editable text — whatever number you pick, a longer sentence is
    silently cut off mid-word on a phone. That shipped once. `1fr` resolves to whatever the text
    actually needs; `min-height:0` on the child is what lets the track reach zero.
  - **That collapse must stay a toggle, never a one-way door.** It shipped one-way once and the
    text was simply gone with no way back. `#lean-toggle` (a chevron, mobile-only) is the way
    back, and it is the only part of the floating header besides the admin bar that takes a tap.
  - **The zoom control moved to `bottomleft`**, with Locate: the top-left corner is under the
    title now.
- **The attribution stays; the `Leaflet` prefix does not.** OpenFreeMap, OpenMapTiles and
  OpenStreetMap credits are required by the tiles' licence and must not be removed or truncated.
  Leaflet's own prefix is a courtesy, and dropping it (`setPrefix('')`, in `initMap` so it runs
  even where geolocation is absent) is what keeps the strip to one line on a phone. The
  bottom-left corner is also lifted 24px on small screens so the Locate button clears it.
- **The page's own copy is editable, and lives on its `projects` row** as `title` / `eyebrow` /
  `intro` (stage 2 moved it off the old `content.fountain_*` keys). `editText()` in the admin
  bar writes all three in **one** `PUT /api/admin/projects/:id`, using the `projectId` that
  `GET /api/fountains` hands back.
  - The copy **rides along in `GET /api/fountains`** (read from the row) rather than costing a
    second call to `/api/content`, which returns the whole site's text and would paint the
    built-in defaults first and then visibly replace them.
  - `TEXT_DEFAULTS` in the page mirrors the seeded strings, so the page still reads correctly if
    the fetch fails or a column was never written.
  - **A stored empty string means deliberately empty; only a NULL column falls back.** The
    handler returns `''` as `''` and omits a NULL, so the page's `txt()` shows blank for the
    first and its default for the second — otherwise clearing the intro would have it reappear
    on the next load. The title is the exception — blank falls back, because a page with no
    title is never what was meant, and `editText()` trims before checking.
  - The save is now **one write, so it is atomic** — the old three-writes-no-transaction hazard
    (and its re-read-on-partial-failure workaround) is gone. A failed save still re-reads from
    the server rather than leaving what was typed on screen.
- The page's `<script>` runs under `node:vm` against stub `L` and `document` objects, which is
  how the parsing, popup-escaping and render behaviour was verified without a browser.

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
