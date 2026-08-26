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
  function navHtml(t, opts) {
    var n = cartCount();
    var cls = 'ch-nav' + (opts.floating ? ' floating' : '') + (opts.navInto ? ' ch-instack' : '');
    return '<nav class="' + cls + '">' +
      '<a class="ch-name" href="/">' + esc(t.nav_name) + '</a>' +
      '<div class="ch-right">' +
        '<ul class="ch-links">' +
          '<li><a href="/">' + esc(t.nav_work) + '</a></li>' +
          '<li><a href="/about">' + esc(t.nav_about) + '</a></li>' +
          '<li><a href="/shop">' + esc(t.nav_shop) + '</a></li>' +
          '<li><a href="/cart">Cart' + (n ? ' (' + n + ')' : '') + '</a></li>' +
          '<li><a href="/contact">' + esc(t.nav_contact) + '</a></li>' +
        '</ul>' +
        (opts.theme === false ? '' :
          '<button class="ch-theme" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">' +
          sunSvg('ch-clip-nav', 22) + '</button>') +
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
      '<a href="/">' + esc(t.nav_work) + '</a>' +
      '<a href="/about">' + esc(t.nav_about) + '</a>' +
      '<a href="/shop">' + esc(t.nav_shop) + '</a>' +
      '<a href="/cart">Cart' + (n ? ' (' + n + ')' : '') + '</a>' +
      '<a href="/contact">' + esc(t.nav_contact) + '</a>' +
      (opts.theme === false ? '' :
        '<button class="ch-mobile-theme" type="button" aria-label="Toggle dark mode">' +
        sunSvg('ch-clip-mob', 20) + '</button>') +
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
    var stored = storedTheme();
    if (stored) document.documentElement.setAttribute('data-theme', stored);

    render(t, opts);

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

    initCursor(opts.cursor);
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
  }

  // A page that wants the site's cursor but not its nav — the client boards are
  // private and deliberately bare — calls cursor() on its own.
  return {
    mount: mount, cursor: initCursor, toggleTheme: toggleTheme,
    cartCount: cartCount, esc: esc
  };
})();
