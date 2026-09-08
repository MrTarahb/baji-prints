/* shared/md.js — a tiny, safe Markdown renderer for admin-authored prose.
   ────────────────────────────────────────────────────────────────────────────
   Loaded by both the public site (public/index.html) and the admin panel
   (public/admin/index.html, for the live preview), so the two never disagree
   about what a given string renders to. Like cld() elsewhere, this is shared
   rather than duplicated.

   It exposes TWO modes on window, and the distinction is load-bearing:

   - mdInline(src): renders ONLY inline spans — **bold**, *italic*, `code`,
     [links](url) — and turns a single newline into <br>. It never emits a
     block element (<p>, <ul>, <h*>). This is what you inject into an element
     that already has its own typography — a title <h1>, a bio <p>, a category
     blurb — so that element's size/weight/style is untouched and plain text
     with no Markdown syntax comes out byte-for-byte the same as before. That
     is the guarantee that lets titles accept Markdown without their large/bold
     look changing.

   - mdBlock(src): full block rendering — blank-line-separated paragraphs,
     - / * and 1. lists, > quotes, and # headings (rendered as a bold line, not
     a real <h*>, so no container needs heading CSS). Only for fields with a
     dedicated block container (the print story, FAQ answers, the shop detail
     description).

   Safety: HTML is escaped FIRST, so nothing the author types can inject markup;
   only the small, known set of Markdown constructs is then turned back into
   tags. Link hrefs are limited to http(s)/mailto/relative/anchor — anything
   else falls back to '#'. The author is trusted (it is the site owner), so this
   is belt-and-braces, but it also stops an accidental stray '<' from breaking a
   layout.

   Placeholders use Private Use Area code points (U+E000/E001), never control
   characters: a NUL or other control byte can survive into the DOM as U+FFFD
   (the trap CLAUDE.md documents), whereas these are (a) stripped before return
   anyway and (b) harmless if one ever leaked. */
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Bold before italic, so ** / __ are consumed before a lone * / _ can be.
  // Underscore italic only fires at word boundaries, so snake_case_words and
  // the underscores in a bare URL are left alone.
  function emph(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/(^|[^A-Za-z0-9_])_([^_]+)_(?=[^A-Za-z0-9_]|$)/g, '$1<em>$2</em>');
  }

  function safeUrl(u) {
    // u has already been HTML-escaped, so &/</>/" are entities; the link regex
    // also stops at whitespace and ')'. Allow only navigable schemes.
    return /^(https?:\/\/|mailto:|\/|#)/i.test(u) ? u : '#';
  }

  // Inline spans. Code and links are pulled out to placeholders first so that
  // emphasis never runs inside a URL or a code span; then restored.
  function inline(raw) {
    var s = esc(raw);
    var store = [];
    var open = '', close = '';
    var tok = function (html) { store.push(html); return open + (store.length - 1) + close; };

    s = s.replace(/`([^`]+)`/g, function (_, c) { return tok('<code>' + c + '</code>'); });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      var url = safeUrl(u);
      var ext = /^https?:\/\//i.test(url);
      return tok('<a href="' + url + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + emph(t) + '</a>');
    });
    s = emph(s);
    s = s.replace(new RegExp(open + '(\\d+)' + close, 'g'), function (_, i) { return store[+i]; });
    return s.replace(/\n/g, '<br>');
  }

  function block(raw) {
    var src = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
    if (!src) return '';
    return src.split(/\n{2,}/).map(function (b) {
      var lines = b.split('\n');
      var h = lines.length === 1 && lines[0].match(/^#{1,3}\s+(.*)$/);
      if (h) return '<p><strong>' + inline(h[1]) + '</strong></p>';
      if (lines.every(function (l) { return /^\s*[-*]\s+/.test(l); }))
        return '<ul>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*[-*]\s+/, '')) + '</li>'; }).join('') + '</ul>';
      if (lines.every(function (l) { return /^\s*\d+\.\s+/.test(l); }))
        return '<ol>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*\d+\.\s+/, '')) + '</li>'; }).join('') + '</ol>';
      if (lines.every(function (l) { return /^\s*>\s?/.test(l); }))
        return '<blockquote>' + inline(lines.map(function (l) { return l.replace(/^\s*>\s?/, ''); }).join('\n')) + '</blockquote>';
      return '<p>' + inline(b) + '</p>';
    }).join('');
  }

  window.mdInline = inline;
  window.mdBlock = block;
})();
