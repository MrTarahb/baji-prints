/* ── SHARED SITE CHROME ──────────────────────────────────────────────────────
   Renders the main site's nav, footer and cursor into a standalone page.
   Pair this with shared/chrome.css. See that file for why this is a second copy
   of what public/index.html carries inline, and what deliberately isn't copied.

   Usage, at the end of the page's own <script>:

     Chrome.mount();                          // nav + footer
     Chrome.mount({ floating: true, footer: false });   // the fountain map

   Everything is optional and degrades: a failed /api/content leaves the
   built-in labels in place, and a page with no fine pointer gets no cursor. */
var Chrome = (function () {
  'use strict';

  // Mirrors the labels seeded in the `content` table. These are what shows if
  // /api/content never answers, so they must read correctly on their own rather
  // than being placeholders.
  var LABELS = {
    nav_name: 'Bharat Bhatia',
    nav_work: 'Portfolio',
    nav_about: 'About',
    nav_shop: 'Shop',
    nav_contact: 'Contact',
    footer_name: 'Bharat Bhatia',
    footer_loc: 'Zürich · Fine art print',
    footer_ig_link: 'https://instagram.com/bajidigital'
  };

  // The horizon mark: a line with a sun that slides below it in dark mode. Two
  // copies of the SVG appear on a page (nav + mobile menu), so the clipPath id
  // has to be unique per instance or the second one clips against the first.
  function sunSvg(id, size) {
    return '<svg class="ch-svg" width="' + size + '" height="' + size + '" viewBox="0 0 32 32" ' +
      'fill="currentColor" aria-hidden="true">' +
      '<defs><clipPath id="' + id + '"><path d="M0 0h32v29h-32z"/></clipPath></defs>' +
      '<path d="M30.7 29.9H1.3c-.7 0-1.3.5-1.3 1.1 0 .6.6 1 1.3 1h29.3c.7 0 1.3-.5 1.3-1.1.1-.5-.5-1-1.2-1z"/>' +
      '<g clip-path="url(#' + id + ')"><path class="ch-sun" d="M16 8.8c-3.4 0-6.1 2.8-6.1 6.1s2.7 6.3 6.1 6.3 ' +
      '6.1-2.8 6.1-6.1-2.7-6.3-6.1-6.3zm13.3 11L26 15l3.3-4.8c.3-.5.1-1.1-.5-1.2l-5.7-1-1-5.7c-.1-.6-.8-.8-1.2-.5L16 ' +
      '5.1l-4.8-3.3c-.5-.4-1.2-.1-1.3.4L8.9 8 3.2 9c-.6.1-.8.8-.5 1.2L6 15l-3.3 4.8c-.3.5-.1 1.1.5 1.2l5.7 1 1 5.7c.1.6.8.8 ' +
      '1.2.5L16 25l4.8 3.3c.5.3 1.1.1 1.2-.5l1-5.7 5.7-1c.7-.1.9-.8.6-1.3zM16 22.5A7.6 7.6 0 0 1 8.3 15c0-4.2 3.5-7.5 ' +
      '7.7-7.5s7.7 3.4 7.7 7.5c0 4.2-3.4 7.5-7.7 7.5z"/></g></svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── THEME ──────────────────────────────────────────────────────────────────
  // The same localStorage key and the same data-theme attribute the main site
  // uses, so a visitor's choice carries across a full page load between them.
  // Every access is guarded: localStorage throws outright in some privacy modes.
  function storedTheme() {
    try { return localStorage.getItem('theme'); } catch (e) { return null; }
  }

  function isDark() {
    var set = document.documentElement.getAttribute('data-theme');
    if (set) return set === 'dark';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function paintTheme() {
    var dark = isDark();
    var svgs = document.querySelectorAll('.ch-svg');
    for (var i = 0; i < svgs.length; i++) svgs[i].classList.toggle('is-dark', dark);
    // Anything on the host page that cannot be repainted by CSS alone listens
    // for this — the fountain map swaps its basemap for a dark one. Dispatched
    // on every paint, the first one included, so a page can also just react to
    // the event rather than reading the attribute itself.
    try {
      document.dispatchEvent(new CustomEvent('ch:theme', { detail: { dark: dark } }));
    } catch (e) {}
  }

  function toggleTheme() {
    var dark = isDark();
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
    try { localStorage.setItem('theme', dark ? 'light' : 'dark'); } catch (e) {}
    paintTheme();
  }

  // ── CART COUNT ─────────────────────────────────────────────────────────────
  // Read from the same localStorage key the shop writes, so the number is right
  // the moment someone arrives here from a page that changed it.
  function cartCount() {
    try {
      var c = JSON.parse(localStorage.getItem('cart') || '[]');
      return c && c.length ? c.length : 0;
    } catch (e) { return 0; }
  }

  // ── CURSOR ─────────────────────────────────────────────────────────────────
  // Built only where there is a real pointer to replace. On a touch device
  // nothing is created and no listener is bound, which is also what keeps a
  // mix-blend-mode element off a layout Android Chrome would detach.
  var CUR_TARGETS_BASE = 'a,button,select';

  function initCursor(extraTargets) {
    if (!window.matchMedia || !window.matchMedia('(hover:hover) and (pointer:fine)').matches) return;
    if (document.getElementById('cur')) return;        // mount() called twice
    var targets = CUR_TARGETS_BASE + (extraTargets ? ',' + extraTargets : '');
    var cur = document.createElement('div');
    cur.id = 'cur';
    document.body.appendChild(cur);
    document.addEventListener('mousemove', function (e) {
      cur.style.left = e.clientX + 'px';
      cur.style.top = e.clientY + 'px';
    });
    // Delegation on document, never a querySelectorAll snapshot: these pages
    // repaint wholesale, so a snapshot taken at load would cover none of what is
    // on the page a second later. mouseover/mouseout bubble where mouseenter and
    // mouseleave do not, and tracking the matched element stops the swell
    // flickering as the pointer crosses children inside the same target.
    var hover = null;
    document.addEventListener('mouseover', function (e) {
      var m = e.target.closest && e.target.closest(targets);
      if (!m || m === hover) return;
      hover = m;
      cur.classList.add('big');
    });
    document.addEventListener('mouseout', function (e) {
      if (!hover) return;
      if (e.relatedTarget && hover.contains(e.relatedTarget)) return;
      hover = null;
      cur.classList.remove('big');
    });
  }

  // ── MARKUP ─────────────────────────────────────────────────────────────────
  // Real hrefs, not the main site's showPage() calls: leaving one of these pages
  // is a genuine navigation, and the server already serves every one of these
  // paths and deep-links the SPA into the right section on arrival.
  // A locked page gets no toggle. Offering one that visibly does nothing is
  // worse than not offering it: the control is the promise.
  function hasToggle(opts) { return opts.theme !== false && !opts.lockTheme; }

  function navHtml(t, opts) {
    var n = cartCount();
    var cls = 'ch-nav' + (opts.floating ? ' floating' : '') + (opts.navInto ? ' ch-instack' : '');
    return '<nav class="' + cls + '">' +
      '<a class="ch-name" href="/">' + esc(t.nav_name) + '</a>' +
      '<div class="ch-right">' +
        '<ul class="ch-links">' +
          '<li class="ch-dd"><a href="/">' + esc(t.nav_work) + '</a>' +
            '<div class="ch-dd-menu"><div class="ch-dd-inner"></div></div></li>' +
          '<li><a href="/about">' + esc(t.nav_about) + '</a></li>' +
          '<li><a href="/shop">' + esc(t.nav_shop) + '</a></li>' +
          '<li><a href="/cart">Cart' + (n ? ' (' + n + ')' : '') + '</a></li>' +
          '<li><a href="/contact">' + esc(t.nav_contact) + '</a></li>' +
        '</ul>' +
        (hasToggle(opts) ?
          '<button class="ch-theme" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">' +
          sunSvg('ch-clip-nav', 22) + '</button>' : '') +
        '<button class="ch-burger" type="button" aria-label="Open menu"><span></span><span></span><span></span></button>' +
      '</div>' +
    '</nav>';
  }

  // The mobile menu is a full-screen overlay and always goes on <body>, never
  // into a host page's stack: nested inside an element with its own z-index it
  // would be trapped under that stacking context — on the map page it would
  // open behind the modal — and inside one with pointer-events:none it would
  // not take a tap at all.
  function mobileHtml(t, opts) {
    var n = cartCount();
    return '<div class="ch-mobile">' +
      '<button class="ch-mobile-close" type="button">Close ✕</button>' +
      '<a href="/" class="ch-mobile-work">' + esc(t.nav_work) + '</a>' +
      '<div class="ch-mobile-sub"></div>' +
      '<a href="/about">' + esc(t.nav_about) + '</a>' +
      '<a href="/shop">' + esc(t.nav_shop) + '</a>' +
      '<a href="/cart">Cart' + (n ? ' (' + n + ')' : '') + '</a>' +
      '<a href="/contact">' + esc(t.nav_contact) + '</a>' +
      (hasToggle(opts) ?
        '<button class="ch-mobile-theme" type="button" aria-label="Toggle dark mode">' +
        sunSvg('ch-clip-mob', 20) + '</button>' : '') +
    '</div>';
  }

  function footerHtml(t) {
    return '<footer class="ch-footer">' +
      '<div>' +
        '<span class="ch-footer-name">' + esc(t.footer_name) + '</span>' +
        '<span class="ch-footer-loc">' + esc(t.footer_loc) + '</span>' +
      '</div>' +
      '<div class="ch-footer-links">' +
        '<a href="' + esc(t.footer_ig_link) + '" target="_blank" rel="noopener">@bajidigital</a>' +
        '<a class="muted" href="/faq">FAQ</a>' +
        '<a class="muted" href="/impressum">Impressum</a>' +
        '<a class="muted" href="/terms">Terms of sale</a>' +
        '<a class="muted" href="/privacy">Privacy</a>' +
      '</div>' +
    '</footer>';
  }

  // ── MOUNT ──────────────────────────────────────────────────────────────────
  // opts.floating  — nav becomes a scrim over the content and takes no pointer
  //                  events (the fountain map is dragged straight through it)
  // opts.footer    — false to omit it, which floating pages want
  // opts.into      — element the footer is appended to; defaults to <body>
  // opts.navInto   — element the nav is prepended to. A page that already floats
  //                  its own fixed stack passes it here so the nav becomes the
  //                  first row of THAT stack rather than a second fixed layer
  //                  competing with it for the top of the screen.
  // opts.theme     — false on a page with one fixed palette, so it does not
  //                  offer a toggle that visibly does nothing there
  // opts.cursor    — extra selectors that should swell the cursor
  function mount(opts) {
    opts = opts || {};
    var t = {};
    for (var k in LABELS) t[k] = LABELS[k];

    // The theme is applied before anything is drawn, so the nav never paints in
    // one theme and then flips.
    //
    // opts.lockTheme pins the page to one palette, ignoring both the stored
    // preference and the system one. It sets data-theme rather than leaving the
    // host page to override the --ch-* tokens itself, because the dark block
    // here is `:root:not([data-theme="light"])` — specificity (0,2,0), which
    // outranks the plain `:root` a host page would write. A page that pinned its
    // tokens that way still went dark for a visitor whose OS is dark, and put
    // white nav text on a light page. The attribute is what these selectors
    // actually test, so setting it settles the question instead of competing
    // with it. It is deliberately NOT written to localStorage: pinning one page
    // must not change the visitor's choice for the rest of the site.
    if (opts.lockTheme) {
      document.documentElement.setAttribute('data-theme', opts.lockTheme);
    } else {
      var stored = storedTheme();
      if (stored) document.documentElement.setAttribute('data-theme', stored);
    }

    render(t, opts);

    // With no attribute and nothing stored, the page is following the OS — so
    // it has to keep following it. A visitor who switches their system to dark
    // with this page open gets the same repaint the toggle would have given
    // them. A visitor who has chosen, or a page that pinned its theme, is left
    // alone: the guard re-reads the attribute rather than trusting this check.
    if (!opts.lockTheme && window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onSystem = function () {
        if (!document.documentElement.getAttribute('data-theme')) paintTheme();
      };
      if (mq.addEventListener) mq.addEventListener('change', onSystem);
      else if (mq.addListener) mq.addListener(onSystem);
    }

    // Labels arrive after the first paint on purpose: the built-in defaults are
    // the real strings, so there is nothing visibly wrong to correct, and the
    // page is not held up by a request it can do without.
    fetch('/api/content', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        if (!c) return;
        var changed = false;
        for (var key in LABELS) {
          if (typeof c[key] === 'string' && c[key] && c[key] !== t[key]) { t[key] = c[key]; changed = true; }
        }
        if (changed) render(t, opts);
      })
      .catch(function () { /* the built-in labels stand */ });

    loadCategories();
    initCursor(opts.cursor);
  }

  // The Portfolio menu, from the live category list — never a hardcoded slug.
  // Renaming a category in admin cascades to the prints but would silently
  // orphan a fixed string here, which is a bug the main site already had once.
  //
  // These are real links, not filter calls: this page has no feed to filter, so
  // each one goes to the main site with the category named in the query string
  // (/?cat=<slug>), which index.html validates against the same list on arrival.
  // Held rather than used once. render() tears the nav down and rebuilds it when
  // the /api/content labels arrive, which threw away a menu that had already
  // been filled — leaving Portfolio opening onto an empty box for the rest of
  // the visit. Whoever paints last has to be able to paint the categories again.
  var categories = null;

  function loadCategories() {
    fetch('/api/categories', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cats) {
        if (!Array.isArray(cats) || !cats.length) return;   // no menu at all
        categories = cats;
        paintCategories();
      })
      .catch(function () { /* no menu rather than a broken one */ });
  }

  // .ch-dd-ready is what lets the menu open. Until the categories are in, the
  // dropdown must not appear at all: an empty bordered box under Portfolio reads
  // as the site being broken, and that is exactly what a hover during the first
  // moments of the page used to produce.
  function paintCategories() {
    if (!categories) return;
    var desk = '<a href="/?cat=all">All work</a><div class="ch-dd-divider"></div>';
    var mob = '';
    categories.forEach(function (c) {
      if (!c.slug) return;
      var href = '/?cat=' + encodeURIComponent(c.slug);
      var label = esc(c.label || c.slug);
      desk += '<a href="' + href + '">' + label + '</a>';
      mob += '<a href="' + href + '">' + label + '</a>';
    });
    var inner = document.querySelector('.ch-dd-inner');
    if (inner) inner.innerHTML = desk;
    var sub = document.querySelector('.ch-mobile-sub');
    if (sub) sub.innerHTML = '<a href="/?cat=all">All work</a>' + mob;
    var dd = document.querySelector('.ch-dd');
    if (dd) dd.classList.add('ch-dd-ready');
  }

  function render(t, opts) {
    var old = document.querySelector('.ch-nav');
    if (old) old.parentNode.removeChild(old);
    var oldMobile = document.querySelector('.ch-mobile');
    if (oldMobile) oldMobile.parentNode.removeChild(oldMobile);
    var oldFooter = document.querySelector('.ch-footer');
    if (oldFooter) oldFooter.parentNode.removeChild(oldFooter);

    (opts.navInto || document.body).insertAdjacentHTML('afterbegin', navHtml(t, opts));
    document.body.insertAdjacentHTML('beforeend', mobileHtml(t, opts));
    if (opts.footer !== false) {
      (opts.into || document.body).insertAdjacentHTML('beforeend', footerHtml(t));
    }
    wire();
    paintCategories();      // this nav is new — the menu has to be refilled
    paintTheme();
  }

  function wire() {
    var menu = document.querySelector('.ch-mobile');
    var burger = document.querySelector('.ch-burger');
    var close = document.querySelector('.ch-mobile-close');
    if (burger && menu) burger.onclick = function () { menu.classList.add('open'); };
    if (close && menu) close.onclick = function () { menu.classList.remove('open'); };
    var themes = document.querySelectorAll('.ch-theme, .ch-mobile-theme');
    for (var i = 0; i < themes.length; i++) themes[i].onclick = toggleTheme;

    // Opened on hover from JS, not :hover, and closed on a delay so crossing
    // the gap between the trigger and the menu doesn't snap it shut.
    var dd = document.querySelector('.ch-dd');
    if (dd) {
      var closeTimer;
      dd.addEventListener('mouseenter', function () {
        clearTimeout(closeTimer);
        dd.classList.add('open');
      });
      dd.addEventListener('mouseleave', function () {
        closeTimer = setTimeout(function () { dd.classList.remove('open'); }, 120);
      });
    }
    // On a phone Portfolio expands its categories in place instead of leaving
    // the page — the same thing the main site's mobile menu does.
    var mw = document.querySelector('.ch-mobile-work');
    var sub = document.querySelector('.ch-mobile-sub');
    if (mw && sub) {
      mw.onclick = function (e) {
        if (!sub.innerHTML) return;        // categories never arrived — just go
        e.preventDefault();
        sub.classList.toggle('open');
      };
    }
  }

  // A page that wants the site's cursor but not its nav — the client boards are
  // private and deliberately bare — calls cursor() on its own.
  return {
    mount: mount, cursor: initCursor, toggleTheme: toggleTheme, isDark: isDark,
    cartCount: cartCount, esc: esc
  };
})();
