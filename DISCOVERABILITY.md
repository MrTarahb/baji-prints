# Discoverability & behavioural analytics — ideas

**Status:** idea stage, nothing built (as of 2026-09-01). This is a brainstorm to decide from,
not a spec.

## The two problems

1. **The portfolio is under-discovered.** Most visitors stay on the main page and never open the
   nav or the mobile hamburger, so they miss the rest of the site. Note that "Portfolio" *is* the
   main-page feed, filtered by category through the nav dropdown — so the real goal is to surface
   **category browsing** and the fact that **there is more to see**, on the page itself.
2. **Photo stories are under-discovered.** A photo can carry a story/caption, shown when you click
   it open (in the lightbox), but few people click — so they never learn a story might be there.

---

## 1. Surfacing the portfolio / "there's more here"

Ordered strongest first.

- **Inline category chips (recommended).** A visible, tappable row of category filters on the feed
  (`All · Abstract · Macro · B&W …`) — the same pattern the client boards already use for series.
  Turns the hidden nav dropdown into something people can't miss, works identically on mobile, and
  keeps people on the page rather than pushing them into a menu.
- **Labelled sections within the feed.** Break the single stream into titled bands (Abstract,
  Macro, …). Scrolling then *reveals* the breadth of the work — the portfolio structure becomes the
  page, no menu required.
- **A scroll / "explore" cue.** A quiet hint that the page continues (a "scroll to explore" line, a
  peeking edge of the next photo, a soft down-chevron). Low effort; addresses "they just stay at the
  top."
- **A more obvious mobile menu.** The hamburger likely fades in / reads as decoration. Labelling it
  "Menu", keeping it always visible, or a one-time subtle pulse raises open rates — but only helps
  people who were already going to look for navigation.

**Lean:** chips first (discovery + filtering in one), optionally with labelled sections.

## 2. Signalling that photos have stories

- **A "has a story" marker (recommended, and honest).** Only on photos that actually have a story
  (derive it from the data — don't mark the purely-visual ones), a small unobtrusive indicator: a
  tiny glyph / dot / corner tag. Answers "which of these is worth tapping?" without clutter.
- **A teaser line.** Show the title or first few words of the story in/near the frame (on hover for
  desktop, always-on or on-scroll for mobile). A partial story is the strongest invitation to open
  it for the whole thing.
- **A one-time onboarding nudge.** The first storied photo a visitor reaches briefly shows "tap to
  read", then fades. Cheap, but a hint rather than a standing affordance.

**Lean:** the marker + a teaser line together — the marker says *which* photos have more, the teaser
gives a taste. Keep it derived from real data so image-only photos stay clean.

---

## 3. How to measure it (behavioural analytics)

Do this first-party — the foundation already exists.

### What's already there
- **`pageviews`** (path, referrer, timestamp) via `POST /api/pageview` — volume by page and source.
- **`photo_views`** (per `print_id`) — already captures photo interest at the individual-photo level.
- An admin **Visits** panel aggregating day / week / month.

The gap: these count **volume**, not **behaviour** — they can't yet answer "what *fraction* of
visitors open the nav?" or "of the photos that have a story, how often is it actually read?"

### The three additions
1. **A generic event stream.** One small `events` table — `event_type`, `path`, optional `meta`
   (JSON), a visit id, timestamp — instead of a table per behaviour. Emit named events:
   `hamburger_open`, `nav_open`, `category_filter` (which category), `photo_open`, `story_shown`
   (only when an opened photo actually had a story), and a couple of `scroll_depth` milestones
   (25/50/75%). Fire-and-forget, same rate limiter as `/api/pageview`.
2. **A per-visit id** (see privacy section — this is an **in-memory** id, not stored). It turns
   "3,000 photo opens" into "**41% of visits opened at least one photo**": rates and funnels need a
   denominator of *visits*, not raw events. Also lets you segment mobile vs desktop, which matters
   because the hamburger problem is mobile-specific.
3. **Two funnels in the Visits panel:**
   - *Nav:* scroll-past-hero → menu/hamburger open → category-filter. Tells you whether people never
     pass the hero (one fix) or pass it but never open the menu (a different fix).
   - *Stories:* photo-open rate per visit, and specifically the open rate on **photos that have a
     story** vs those that don't.

### Measurement design (the part that matters)
- **Baseline first.** Instrument, then collect ~1–2 weeks of *current* behaviour before changing
  anything — otherwise there's nothing to compare against.
- **Prefer an A/B split over before/after.** Bucket visits 50/50 (from the in-memory id, or a
  server coin-flip) and show chips / the story marker to one bucket only. Concurrent cohorts remove
  the confounds that wreck before/after: seasonality, a traffic spike from one Instagram post, etc.
- **Segment and filter.** Split mobile/desktop, filter obvious bots, watch referrer (a burst of
  low-intent traffic can look like "engagement dropped").
- **Prune the table.** Behavioural events grow fast — roll old rows into daily aggregates, or sample
  high-volume events.

### Build-your-own vs hosted
- **Extend the existing tables** (above) — fits the site's all-first-party, no-keys ethos; the
  Visits panel already exists to host it. More to build. **Recommended given the site's character.**
- **Hosted privacy-first analytics** (Plausible / Umami / PostHog) — funnels/heatmaps in an
  afternoon, but a third-party dependency and script, a departure from how the site works today.
  Faster way to *learn* if you want to validate the hypotheses before investing.

---

## 4. Privacy constraint — no cookie banner, no personal data

**Hard requirement:** the tracking must need **no cookie-consent banner** and store **no personal
data**. That is achievable and actually *simpler*; two rules cover it.

1. **Store nothing on the device for analytics.** Generate a **random id in memory when the page
   loads**, attach it to that visit's events, and let it die on reload — never written to a cookie
   or localStorage. Because the site is a SPA, one page load *is* one visit, so this still ties a
   visit's events together for funnel math without touching the device. *(A persistent
   localStorage/cookie id — floated earlier in discussion — is exactly what would require consent;
   don't use one.)*
2. **Store no personal data server-side.** Keep only `event_type`, `path`, the in-memory visit id,
   timestamp, and referrer **trimmed to its domain**. **No IP, no user-agent, no fingerprint.**
   (`pageviews` already stores only path + referrer; the IP `trackLimiter` sees is used transiently
   for rate-limiting and never stored — fine.)

This is the "Plausible-style, no persistent identifier" pattern: aggregate, anonymous, nothing to
consent to.

**What it costs:** no returning-visitor tracking and no cross-day unique-visitor dedup (a reloader
is counted twice). But both problems above are **per-visit** questions ("did *this* visit open the
nav / a storied photo?"), so a per-visit id answers them fully. The constraint barely touches what
we want to learn.

**Existing localStorage is fine.** Cart, theme choice, and the `bp-lb-big` lightbox preference are
**functional** storage (remembering something the user did/chose), not tracking — consent-exempt, no
banner needed. The line we're avoiding is specifically *analytics identifiers*.

*(Not legal advice, but "store nothing on the device, keep no PII, aggregate only" is the safe
posture under both Switzerland's revFADP and the GDPR.)*

---

## Suggested first slice

1. **Instrument (privacy-safe):** an `events` table + the in-memory visit id + the events above,
   surfaced as the two funnels in the Visits panel. Ship it, collect a baseline.
2. **Then change one thing** — the category chips are the highest-leverage UI move — behind a 50/50
   A/B split, and compare.
3. Repeat for the story marker.
