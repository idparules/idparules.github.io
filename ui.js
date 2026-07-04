/*
 * ui.js — wires the parser + normalizer + diff engine to the page. Vanilla DOM.
 *
 * The view is an IntelliJ-style, full-document side-by-side diff: both rulebooks
 * are rendered in full for context, with matching rules aligned on the same row
 * and changes highlighted in place. Prev/Next controls (and the n / p keys) walk the
 * differences. State (years, toggles, filter) lives in the URL hash as a shareable
 * permalink.
 */
(function () {
  'use strict';

  var Parser = window.RulebookParser;
  var Diff = window.RulebookDiff;

  var els = {};
  var modelCache = new Map();   // "docId:year" → parsed model
  var docs = [];                // manifest: [{ id, label, file, years }]
  var lastAlign = null;

  // iOS Safari (incl. iPadOS, which masquerades as Macintosh) needs special
  // handling: its sticky elements lag/flicker during programmatic scroll jumps.
  var IS_IOS = /iP(ad|hone|od)/.test(navigator.userAgent) ||
    (navigator.userAgent.indexOf('Macintosh') >= 0 && navigator.maxTouchPoints > 1);

  // Navigation over the rendered difference rows.
  var diffEls = [];
  var currentDiff = -1;
  var navTargetIndex = null;      // logical Prev/Next cursor; null = derive from scroll
  var navigating = false;         // true while a programmatic nav scroll settles
  var navClearTimer = 0;

  // Chapter/section heading rows, for scroll-spy highlighting in the sidebar.
  var headingEls = [];
  var lastSpyChap, lastSpySec;

  var state = {
    doc: 'rulebook',              // which document: rulebook / equipment / match-admin
    base: null,
    compare: null,
    view: 'sbs',                  // 'sbs' = side by side (default); 'uni' = one document with inline changes
    changed: false,               // false = full document (context); true = only changes
    sections: true,               // list sections under each chapter in the sidebar
    emphasize: false,             // underline/strikethrough + marker chars on word-level changes
    at: null,                     // anchor (chap-N / sec-N) reflected in the address bar
    opts: { whitespace: true, quotes: true, punctuation: true, case: true }
  };

  var pendingAnchor = null;       // anchor to scroll to after the next render

  // ---------- utilities ----------

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function debounce(fn, ms) {
    var t;
    function debounced() { clearTimeout(t); t = setTimeout(fn, ms); }
    debounced.cancel = function () { clearTimeout(t); };
    return debounced;
  }

  function applyEmphasizeClass() {
    document.body.classList.toggle('emphasize-changes', state.emphasize);
  }

  function currentDoc() {
    for (var i = 0; i < docs.length; i++) if (docs[i].id === state.doc) return docs[i];
    return docs[0];
  }
  function years() { var d = currentDoc(); return d ? d.years : []; }
  function docKey(year) { return state.doc + ':' + year; }

  // Same year on both sides = plain reading mode: show that rulebook as a
  // single document, no diff. Rendering uses the unified (one-column) path.
  function isSingleYear() { return state.base === state.compare; }
  function isUniView() { return state.view === 'uni' || isSingleYear(); }

  // Split on dots, slashes, and dashes so hyphenated ids (match admin's
  // M-1 … M-18) compare numerically: M-2 < M-10.
  function compareIds(a, b) {
    var pa = String(a).split(/[.\/-]/);
    var pb = String(b).split(/[.\/-]/);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10), nb = parseInt(pb[i], 10);
      if (!isNaN(na) && !isNaN(nb)) { if (na !== nb) return na - nb; }
      else { var sa = pa[i] || '', sb = pb[i] || ''; if (sa !== sb) return sa < sb ? -1 : 1; }
    }
    return 0;
  }

  // ---------- hash state ----------

  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return null;
    var params = {};
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return params;
  }

  function applyHash(params) {
    if (!params) return;
    // The doc has to resolve first — base/cmp are validated against its years.
    if (params.doc) {
      for (var i = 0; i < docs.length; i++) {
        if (docs[i].id === params.doc) { state.doc = params.doc; break; }
      }
    }
    var ys = years();
    state.base = state.compare = ys[ys.length - 1];
    if (params.base && ys.indexOf(params.base) >= 0) state.base = params.base;
    if (params.cmp && ys.indexOf(params.cmp) >= 0) state.compare = params.cmp;
    if (params.view === 'uni' || params.view === 'sbs') state.view = params.view;
    if (params.changed !== undefined) state.changed = params.changed === '1';
    if (params.secs !== undefined) state.sections = params.secs === '1';
    if (params.em !== undefined) state.emphasize = params.em === '1';
    if (params.ws !== undefined) state.opts.whitespace = params.ws === '1';
    if (params.q !== undefined) state.opts.quotes = params.q === '1';
    if (params.p !== undefined) state.opts.punctuation = params.p === '1';
    if (params.c !== undefined) state.opts.case = params.c === '1';
    if (params.at) state.at = params.at;
  }

  function writeHash() {
    var o = state.opts;
    var parts = [
      'doc=' + encodeURIComponent(state.doc),
      'base=' + encodeURIComponent(state.base),
      'cmp=' + encodeURIComponent(state.compare),
      'view=' + state.view,
      'changed=' + (state.changed ? '1' : '0'),
      'secs=' + (state.sections ? '1' : '0'),
      'em=' + (state.emphasize ? '1' : '0'),
      'ws=' + (o.whitespace ? '1' : '0'),
      'q=' + (o.quotes ? '1' : '0'),
      'p=' + (o.punctuation ? '1' : '0'),
      'c=' + (o.case ? '1' : '0')
    ];
    if (state.at) parts.push('at=' + encodeURIComponent(state.at));
    var hash = '#' + parts.join('&');
    if (hash !== location.hash) history.replaceState(null, '', hash);
  }

  // ---------- loading ----------

  function loadManifest() {
    return fetch('rulebooks/manifest.json').then(function (r) {
      if (!r.ok) throw new Error('manifest.json ' + r.status);
      return r.json();
    });
  }

  function loadDoc(year) {
    var key = docKey(year);
    if (modelCache.has(key)) return Promise.resolve(modelCache.get(key));
    var doc = currentDoc();
    return fetch('rulebooks/' + doc.file + year + '.md')
      .then(function (r) { if (!r.ok) throw new Error(doc.label + ' ' + year + ' ' + r.status); return r.text(); })
      .then(function (text) { var m = Parser.parseRulebook(text); modelCache.set(key, m); return m; });
  }

  // ---------- controls ----------

  function fillSelect(sel, years, selected) {
    sel.innerHTML = '';
    years.forEach(function (y) {
      var opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      if (y === selected) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  // The document switcher: one tab per manifest doc.
  function renderDocTabs() {
    els.docTabs.innerHTML = docs.map(function (d) {
      return '<button type="button" class="doc-tab' + (d.id === state.doc ? ' active' : '') +
        '" data-doc="' + escapeHtml(d.id) + '" aria-pressed="' + (d.id === state.doc ? 'true' : 'false') + '">' +
        escapeHtml(d.label) + '</button>';
    }).join('');
  }

  // Switch document, carrying the reading-vs-comparing intent over: reading
  // mode stays on the new doc's latest year; a comparison becomes latest vs
  // previous of the new doc. Anchors are document-specific, so drop them.
  function switchDoc(id) {
    if (id === state.doc) return;
    var comparing = !isSingleYear();
    state.doc = id;
    var ys = years();
    state.compare = ys[ys.length - 1];
    state.base = comparing && ys.length > 1 ? ys[ys.length - 2] : state.compare;
    state.at = null;
    pendingAnchor = null;
    if (els.showChanged) els.showChanged.disabled = ys.length < 2;
    renderDocTabs();
    syncControlsFromState();
    writeHash();
    recompute().then(function () { window.scrollTo({ top: 0, behavior: 'auto' }); });
  }

  function syncControlsFromState() {
    fillSelect(els.base, years(), state.base);
    fillSelect(els.compare, years(), state.compare);
    els.whitespace.checked = state.opts.whitespace;
    els.quotes.checked = state.opts.quotes;
    els.punctuation.checked = state.opts.punctuation;
    els.case.checked = state.opts.case;
    els.changed.checked = state.changed;
    els.sections.checked = state.sections;
    els.emphasize.checked = state.emphasize;
    els.viewUni.checked = state.view === 'uni';
    els.viewSbs.checked = state.view === 'sbs';
  }

  function readStateFromControls() {
    state.base = els.base.value;
    state.compare = els.compare.value;
    state.opts.whitespace = els.whitespace.checked;
    state.opts.quotes = els.quotes.checked;
    state.opts.punctuation = els.punctuation.checked;
    state.opts.case = els.case.checked;
    state.changed = els.changed.checked;
    state.sections = els.sections.checked;
    state.emphasize = els.emphasize.checked;
    state.view = els.viewSbs.checked ? 'sbs' : 'uni';
  }

  // ---------- diff-side rendering ----------

  // Left column: everything not added (equal + removed), removals struck through.
  function diffLeftHtml(diff) {
    return diff.filter(function (p) { return !p.added; }).map(function (p) {
      var t = escapeHtml(p.value);
      return p.removed ? '<del class="diff">' + t + '</del>' : t;
    }).join('');
  }

  // Right column: everything not removed (equal + added), additions underlined.
  function diffRightHtml(diff) {
    return diff.filter(function (p) { return !p.removed; }).map(function (p) {
      var t = escapeHtml(p.value);
      return p.added ? '<ins class="diff">' + t + '</ins>' : t;
    }).join('');
  }

  // Unified (single-document) view: old and new interleaved — removals struck
  // through in place, additions highlighted right after them.
  function diffUnifiedHtml(diff) {
    return diff.map(function (p) {
      var t = escapeHtml(p.value);
      if (p.removed) return '<del class="diff">' + t + '</del>';
      if (p.added) return '<ins class="diff">' + t + '</ins>';
      return t;
    }).join('');
  }

  // Inner HTML for one cell of a row, on a given side ('left' | 'right' | 'uni').
  // 'uni' renders the row's primary block with old/new interleaved inline.
  function cellInner(row, side) {
    var block = side === 'left' ? row.left : side === 'right' ? row.right : (row.right || row.left);
    if (!block) return '';   // spacer opposite an add/remove

    var textHtml;
    if (row.diff) {
      textHtml = side === 'left' ? diffLeftHtml(row.diff)
        : side === 'right' ? diffRightHtml(row.diff)
        : diffUnifiedHtml(row.diff);
    } else {
      textHtml = escapeHtml(block.text);
    }

    if (block.type === 'chapter' || block.type === 'section') {
      return '<div class="cell-heading ' + block.type + '">' + headingNumHtml(row, block, side) + ' ' +
        textHtml + '</div>';
    }

    var html = ruleIdHtml(row, block, side) + '<span class="cell-text">' + textHtml + '</span>';
    // A figure renders its image below the caption. alt is empty because the
    // caption is adjacent visible text; onerror hides the broken-image glyph so
    // a not-yet-extracted file degrades to a plain caption line.
    if (block.type === 'figure' && block.src) {
      html += '<img class="figure-img" loading="lazy" alt="" src="rulebooks/' +
        escapeHtml(encodeURI(block.src)) + '" onerror="this.classList.add(\'missing\')">';
    }
    return html;
  }

  // Every block has a unique alignment key (chap:2, sec:2.7, rule:2.12.3.3,
  // pre:2.9/preamble-1); turn it into a stable, URL-safe anchor. Chapters and
  // sections keep their existing chap-N / sec-N form for backward-compatible links.
  function anchorFor(block) { return block.key.replace(/[:#/]/g, '-'); }

  function rowAnchor(row) {
    var b = row.right || row.left;
    return b ? anchorFor(b) : null;
  }

  // The chapter/section number is itself a copy-link, exactly like a rule-id
  // badge (clicking the heading TEXT still selects/scrolls it instead).
  function headingNumHtml(row, block, side) {
    var primarySide = row.right ? 'right' : 'left';
    if (side !== primarySide && side !== 'uni') {
      return '<span class="hnum">' + escapeHtml(block.id) + '</span>';
    }
    var anchor = rowAnchor(row);
    var label = 'Copy link to ' + block.type + ' ' + block.id;
    return '<button type="button" tabindex="-1" class="hnum link-hnum" data-anchor="' + escapeHtml(anchor) +
      '" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' + escapeHtml(block.id) + '</button>';
  }

  // The rule/preamble id badge is itself a copy-link (one per row, on the side
  // that carries the id). tabindex -1 keeps ~600 badges out of the tab order.
  function ruleIdHtml(row, block, side) {
    var isPre = block.type === 'preamble';
    var isFig = block.type === 'figure';
    var content = isPre ? '¶' : isFig ? 'fig' : escapeHtml(block.id);
    var mod = isPre || isFig ? ' preamble' : '';
    var primarySide = row.right ? 'right' : 'left';
    if (side !== primarySide && side !== 'uni') {
      return '<span class="cell-id' + mod + '">' + content + '</span>';
    }
    var anchor = rowAnchor(row);
    var label = 'Copy link to ' + (isPre ? 'this intro text' : isFig ? 'this figure' : 'rule ' + block.id);
    return '<button type="button" tabindex="-1" class="cell-id link-id' + mod +
      '" data-anchor="' + escapeHtml(anchor) + '" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' +
      content + '</button>';
  }

  function rowHtml(row, index) {
    var anchorId = rowAnchor(row);
    var attrs = 'class="drow ' + row.kind + ' type-' + row.type + '"';
    if (anchorId) attrs += ' id="' + anchorId + '" data-anchor="' + escapeHtml(anchorId) + '"';
    if (row.kind !== 'unchanged') attrs += ' data-diff-index="' + index + '" data-kind="' + row.kind + '"';

    if (isUniView()) {
      return '<div ' + attrs + '><div class="dcell uni">' + cellInner(row, 'uni') + '</div></div>';
    }

    var leftEmpty = row.left ? '' : ' empty';
    var rightEmpty = row.right ? '' : ' empty';
    return '<div ' + attrs + '>' +
      '<div class="dcell left' + leftEmpty + '">' + cellInner(row, 'left') + '</div>' +
      '<div class="dcell right' + rightEmpty + '">' + cellInner(row, 'right') + '</div>' +
      '</div>';
  }

  function metaLine(year) {
    var m = modelCache.get(docKey(year));
    if (!m || !m.meta) return escapeHtml(year);
    var bits = [year];
    if (m.meta.version) bits.push('Ver. ' + m.meta.version);
    if (m.meta.amended) bits.push('amended ' + m.meta.amended);
    return escapeHtml(bits.join(' · '));
  }

  // Shared by the Settings-panel version line and its inline repeat above the
  // diff (see renderVersionMeta / versionMetaBannerHtml).
  function versionMetaInnerHtml() {
    if (isSingleYear()) return metaLine(state.base);
    return '<span class="col-tag">Base</span> ' + metaLine(state.base) +
      '<span class="version-sep">→</span>' +
      '<span class="col-tag">Compare</span> ' + metaLine(state.compare);
  }

  // Base/Compare version details, shown in the Settings panel instead of a
  // second sticky bar above the diff (that bar was a second scroll-position-
  // dependent element competing with the header — dropping it removes a whole
  // class of iOS Safari stickiness lag/flicker).
  function renderVersionMeta() {
    if (!els.versionMeta) return;
    els.versionMeta.innerHTML = versionMetaInnerHtml();
  }

  // Same info again, inline at the top of the diff content — visible without
  // opening Settings, and placed above the source-notes warnings box. Laid
  // out as Base/Compare columns matching the diff rows below (single column
  // in unified/reading mode, where the diff itself is one column too).
  function versionMetaBannerHtml() {
    if (isUniView()) {
      // Reading mode (base === compare): just the one version. Document/inline
      // view over two different years: still one column, but note both since
      // the document shown is Compare's structure with Base's changes inlined.
      var cell = isSingleYear() ? metaLine(state.base)
        : '<span class="col-tag">Compare</span> ' + metaLine(state.compare) +
          ' <span class="version-sep">·</span> <span class="col-tag">Base</span> ' + metaLine(state.base);
      return '<div class="version-meta-banner uni"><div class="dcell uni">' + cell + '</div></div>';
    }
    return '<div class="version-meta-banner">' +
      '<div class="dcell left"><span class="col-tag">Base</span> ' + metaLine(state.base) + '</div>' +
      '<div class="dcell right"><span class="col-tag">Compare</span> ' + metaLine(state.compare) + '</div>' +
      '</div>';
  }

  // ---------- main render ----------

  function render() {
    var al = lastAlign;
    var summary = al.summary;

    renderSummary(summary);
    renderToc(al.rows);
    renderVersionMeta();

    var versionBanner = versionMetaBannerHtml();
    var warnings = warningsHtml();

    var diffIndex = 0;
    var body = al.rows.map(function (row) {
      // In "changed only" mode, drop unchanged rules/prose but keep chapter and
      // section headings so the remaining changes stay anchored to their place.
      if (state.changed && row.kind === 'unchanged' &&
          (row.type === 'rule' || row.type === 'preamble' || row.type === 'figure')) return '';
      var idx = row.kind !== 'unchanged' ? diffIndex++ : -1;
      return rowHtml(row, idx);
    }).join('');

    if (!body) {
      els.changes.innerHTML = versionBanner + warnings + '<p class="empty-state">No differences to show with the current settings.</p>';
      resetNav();
      return;
    }

    els.changes.innerHTML = versionBanner + warnings +
      '<div class="diff-doc' + (isUniView() ? ' unified' : '') + '">' + body + '</div>';

    // Rebuild the navigation list and heading index from what actually rendered.
    diffEls = Array.prototype.slice.call(els.changes.querySelectorAll('[data-diff-index]'));
    headingEls = Array.prototype.slice.call(els.changes.querySelectorAll('.drow.type-chapter, .drow.type-section'))
      .map(function (el) {
        return { el: el, type: el.classList.contains('type-chapter') ? 'chapter' : 'section', number: el.id.replace(/^(chap|sec)-/, '') };
      });
    currentDiff = -1;
    navTargetIndex = null;
    updateHeaderOffset();

    // Restore a linked anchor (from a permalink or back/forward), then sync the
    // current-difference indicator and sidebar highlight to wherever we end up.
    if (pendingAnchor) { scrollToAnchor(pendingAnchor); pendingAnchor = null; }
    setCurrent(computeActiveIndex());
    refreshTocSpy();
  }

  function renderSummary(summary) {
    if (isSingleYear()) {
      var nRules = lastAlign.rows.filter(function (r) { return r.type === 'rule'; }).length;
      els.summary.innerHTML = '<span class="summary-meta">Reading the ' + escapeHtml(state.base) + ' ' +
        escapeHtml(currentDoc().label) + ' · ' + nRules + ' rules · pick a different Base or Compare year to see changes</span>';
      return;
    }

    var kinds = ['added', 'removed', 'modified'];
    var chips = kinds.map(function (k) {
      var n = summary[k] || 0;
      var disabled = n === 0 ? ' disabled' : '';
      return '<button type="button" class="summary-chip ' + k + '"' + disabled + ' data-kind="' + k + '">' +
        '<span class="count">' + n + '</span> ' + k.charAt(0).toUpperCase() + k.slice(1) + '</button>';
    }).join('');
    var meta = '<span class="summary-meta">' + summary.unchanged + ' unchanged · ' +
      escapeHtml(state.base) + ' → ' + escapeHtml(state.compare) + '</span>';
    els.summary.innerHTML = chips + meta;

    Array.prototype.forEach.call(els.summary.querySelectorAll('.summary-chip'), function (btn) {
      if (btn.disabled) return;
      btn.addEventListener('click', function () { jumpToKind(btn.getAttribute('data-kind')); });
    });
  }

  function yearWarnings(year) {
    var m = modelCache.get(docKey(year));
    return (m && m.warnings) || [];
  }

  // One column's worth of source notes: an optional Base/Compare tag (column
  // position already conveys which side once there are two), then the
  // messages for that year, or a "none" placeholder so both cells still line
  // up when only one side has anything to report.
  function warningsCellHtml(tag, year) {
    var msgs = yearWarnings(year);
    var body = msgs.length ? msgs.map(escapeHtml).join(' · ') : '<span class="warnings-none">No source notes</span>';
    var label = tag ? '<span class="col-tag">' + tag + '</span> ' : '';
    return label + body;
  }

  function warningsHtml() {
    var baseMsgs = yearWarnings(state.base);
    var compareMsgs = isSingleYear() ? [] : yearWarnings(state.compare);
    if (!baseMsgs.length && !compareMsgs.length) return '';

    var head = '<div class="warnings-head">Source notes</div>';
    if (isUniView()) {
      var cell = isSingleYear()
        ? warningsCellHtml('', state.base)
        : warningsCellHtml('Base', state.base) + ' <span class="version-sep">·</span> ' + warningsCellHtml('Compare', state.compare);
      return '<div class="warnings uni">' + head + '<div class="dcell uni">' + cell + '</div></div>';
    }
    return '<div class="warnings">' + head +
      '<div class="dcell left">' + warningsCellHtml('Base', state.base) + '</div>' +
      '<div class="dcell right">' + warningsCellHtml('Compare', state.compare) + '</div>' +
      '</div>';
  }

  function renderToc(rows) {
    var chapters = {};   // number → { number, title, count, sections, secOrder }
    var order = [];
    rows.forEach(function (row) {
      var ctx = row.right || row.left;
      if (!ctx.chapter) return;
      var cn = ctx.chapter.number;
      if (!chapters[cn]) { chapters[cn] = { number: cn, title: ctx.chapter.title, count: 0, sections: {}, secOrder: [] }; order.push(cn); }
      var ch = chapters[cn];
      var changed = row.kind !== 'unchanged';
      if (changed) ch.count++;
      if (ctx.section) {
        var sn = ctx.section.number;
        if (!ch.sections[sn]) { ch.sections[sn] = { number: sn, title: ctx.section.title, count: 0 }; ch.secOrder.push(sn); }
        if (changed) ch.sections[sn].count++;
      }
    });

    // Full table of contents: every chapter (and section), with a change-count
    // badge only where there are changes.
    var list = order.map(function (k) { return chapters[k]; })
      .sort(function (a, b) { return compareIds(a.number, b.number); });

    if (!list.length) { els.toc.innerHTML = ''; return; }

    var tocLink = function (anchor, label, count) {
      return '<a href="#' + escapeHtml(anchor) + '" data-anchor="' + escapeHtml(anchor) + '">' +
        '<span>' + escapeHtml(label) + '</span>' +
        (count > 0 ? '<span class="toc-count">' + count + '</span>' : '') + '</a>';
    };

    var items = list.map(function (c) {
      var secHtml = '';
      if (state.sections) {
        var secs = c.secOrder.map(function (k) { return c.sections[k]; })
          .sort(function (a, b) { return compareIds(a.number, b.number); });
        if (secs.length) {
          secHtml = '<ul class="toc-sections">' + secs.map(function (s) {
            return '<li>' + tocLink('sec-' + s.number, s.number + ' ' + s.title, s.count) + '</li>';
          }).join('') + '</ul>';
        }
      }
      return '<li>' + tocLink('chap-' + c.number, c.number + ' ' + c.title, c.count) + secHtml + '</li>';
    }).join('');

    els.toc.innerHTML = '<h2>Contents</h2><ul>' + items + '</ul>';
  }

  // ---------- navigation (scroll-position based) ----------

  // The reference line just below the sticky/fixed header; a row is "current"
  // once its top reaches this line. Must match .drow's scroll-margin-top (see
  // style.css) — that's where scrollIntoView actually parks a row's top, so
  // using a different offset here made the TOC/Prev-Next "current" indicator
  // land one row early right after any anchor-based scroll. Uses offsetHeight
  // (a stable box metric) rather than getBoundingClientRect() on the sticky
  // header, which iOS Safari reports transiently while it re-stickies during
  // a programmatic scroll.
  function topOffset() {
    var header = document.querySelector('.app-header');
    return (header ? header.offsetHeight : 0) + 40;
  }

  function resetNav() { diffEls = []; currentDiff = -1; navTargetIndex = null; updateCounter(); }

  // ---------- sidebar scroll-spy ----------

  // Highlight the chapter/section you're currently viewing. Heading rows are in
  // document order, so scan until the first one below the reference line; a
  // chapter heading resets the "current section" (you've entered its preamble).
  function updateTocSpy() {
    if (!headingEls.length) return;
    var line = topOffset() + 1;
    var curChap = null, curSec = null, passed = false;
    for (var i = 0; i < headingEls.length; i++) {
      var h = headingEls[i];
      if (h.el.getBoundingClientRect().top <= line) {
        passed = true;
        if (h.type === 'chapter') { curChap = h.number; curSec = null; }
        else curSec = h.number;
      } else break;
    }
    // At the very top (nothing scrolled past yet), highlight the first chapter.
    if (!passed && headingEls[0]) {
      if (headingEls[0].type === 'chapter') curChap = headingEls[0].number;
      else curSec = headingEls[0].number;
    }
    if (curChap === lastSpyChap && curSec === lastSpySec) return;
    lastSpyChap = curChap; lastSpySec = curSec;

    var links = els.toc.querySelectorAll('a[data-anchor]');
    var activeAnchor = curSec !== null ? 'sec-' + curSec : (curChap !== null ? 'chap-' + curChap : null);
    var activeEl = null;
    for (var j = 0; j < links.length; j++) {
      var anc = links[j].getAttribute('data-anchor');
      var active = anc === activeAnchor;
      links[j].classList.toggle('active', active);
      if (active) activeEl = links[j];
    }
    // The sidebar scrolls independently of the page — keep the highlighted item
    // inside its own viewport as the highlight moves, without touching the
    // page's scroll position.
    scrollTocContainerTo(activeEl);
  }

  // Scroll only the .toc box's own scrollTop, computed from bounding rects so it
  // never touches window scroll (avoids any feedback with the scroll listener).
  function scrollTocContainerTo(el) {
    if (!el) return;
    var box = els.toc;
    var boxRect = box.getBoundingClientRect();
    var elRect = el.getBoundingClientRect();
    var margin = 8;
    if (elRect.top < boxRect.top + margin) {
      box.scrollTop += elRect.top - boxRect.top - margin;
    } else if (elRect.bottom > boxRect.bottom - margin) {
      box.scrollTop += elRect.bottom - boxRect.bottom + margin;
    }
  }

  // Force the highlight to reapply after the TOC is (re)rendered.
  function refreshTocSpy() { lastSpyChap = lastSpySec = ' '; updateTocSpy(); }

  function updateCounter() {
    var total = diffEls.length;
    els.prev.disabled = els.next.disabled = (total === 0);
    if (!total) { els.counter.textContent = 'No differences'; return; }
    els.counter.textContent = (currentDiff < 0 ? 1 : currentDiff + 1) + ' / ' + total;
  }

  // Index of the first difference whose bottom is still below the reference line
  // — i.e. the change you're currently at or scrolling toward.
  function computeActiveIndex() {
    if (!diffEls.length) return -1;
    var line = topOffset();
    for (var i = 0; i < diffEls.length; i++) {
      if (diffEls[i].getBoundingClientRect().bottom > line + 0.5) return i;
    }
    return diffEls.length - 1;
  }

  function setCurrent(i) {
    if (currentDiff >= 0 && diffEls[currentDiff]) diffEls[currentDiff].classList.remove('current');
    currentDiff = i;
    if (i >= 0 && diffEls[i]) diffEls[i].classList.add('current');
    updateCounter();
  }

  // Bring a row to just below the sticky header. Uses scrollIntoView (which
  // honors the CSS scroll-margin-top on .drow) instead of computing an absolute
  // y from window.scrollY + the sticky header's rect — both of which iOS Safari
  // reports unreliably mid-scroll, causing the page to jerk and the header to
  // flash out when Prev/Next is tapped quickly.
  function scrollElToLine(el) {
    el.scrollIntoView({ block: 'start', inline: 'nearest' });
  }

  // Deferred so a burst of taps produces ONE history.replaceState at the end —
  // iOS Safari both rate-limits replaceState and can twitch browser chrome when
  // the URL changes mid-scroll.
  var scheduleNavHashWrite = debounce(writeHash, 300);

  // Scroll to a difference AND record its anchor in the address bar, so Prev/Next
  // (and summary-chip jumps) keep the URL pointed at where you are.
  function goToDiff(el) {
    if (!el) return;
    var a = el.getAttribute('data-anchor');
    if (a) { state.at = a; scheduleNavHashWrite(); }
    scrollElToLine(el);
  }

  // Index of the last difference whose top has passed the reference line — the
  // one currently aligned at/above it. -1 at the very top (none reached yet).
  function currentAlignedIndex() {
    var line = topOffset() + 2;
    var idx = -1;
    for (var i = 0; i < diffEls.length; i++) {
      if (diffEls[i].getBoundingClientRect().top <= line) idx = i; else break;
    }
    return idx;
  }

  // Step through differences by a logical cursor rather than re-reading live
  // scroll positions on every tap. During a burst of Prev/Next taps the cursor
  // advances deterministically (+/-1 each) without depending on getBoundingClientRect,
  // which iOS Safari reports transiently mid-scroll. `navigating` keeps the scroll
  // listener from resetting the cursor while the programmatic scroll settles.
  function requestNav(delta) {
    if (!diffEls.length) return;
    var base = navTargetIndex !== null ? navTargetIndex : currentAlignedIndex();
    var target = base + delta;
    if (target < 0) target = diffEls.length - 1;         // wrap
    else if (target >= diffEls.length) target = 0;
    navTargetIndex = target;
    navigating = true;
    clearTimeout(navClearTimer);
    navClearTimer = setTimeout(function () { navigating = false; }, 250);
    goToDiff(diffEls[target]);
  }

  function nextDiff() { requestNav(1); }
  function prevDiff() { requestNav(-1); }

  function jumpToKind(kind) {
    for (var i = 0; i < diffEls.length; i++) {
      if (diffEls[i].getAttribute('data-kind') === kind) {
        navTargetIndex = i; navigating = false;
        goToDiff(diffEls[i]);
        return;
      }
    }
  }

  // ---------- section / chapter linking ----------

  function scrollToAnchor(anchor) {
    if (!anchor) return;
    var el = document.getElementById(anchor);
    if (el) scrollElToLine(el);
  }

  // Click a heading: reflect it in the address bar and scroll it into place.
  // A heading may not be a difference row, so let Prev/Next re-derive the cursor
  // from the landed scroll position.
  function selectAnchor(anchor) {
    state.at = anchor;
    writeHash();
    navTargetIndex = null; navigating = false;
    scrollToAnchor(anchor);
  }

  function copyAnchorLink(anchor, btn) {
    state.at = anchor;
    writeHash();
    var url = location.href;
    function done() { flashCopied(btn); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { legacyCopy(url); done(); });
    } else { legacyCopy(url); done(); }
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function flashCopied(btn) {
    if (!btn) return;
    btn.classList.add('copied');
    setTimeout(function () { btn.classList.remove('copied'); }, 1200);
  }

  // ---------- recompute ----------

  function recompute() {
    // Same year both sides is fine: aligning a document with itself yields
    // all-unchanged rows, i.e. plain reading mode (see isSingleYear()).
    return Promise.all([loadDoc(state.base), loadDoc(state.compare)])
      .then(function (models) {
        lastAlign = Diff.alignDocuments(models[0], models[1], state.opts);
        render();
      })
      .catch(function (err) {
        els.changes.innerHTML = '<p class="empty-state">Could not load rulebooks: ' + escapeHtml(err.message) + '</p>';
        resetNav();
      });
  }

  var scheduleRecompute = debounce(function () { writeHash(); recompute(); }, 120);

  // ---------- header offset (keeps the sticky column labels below the header) ----------

  function updateHeaderOffset() {
    var header = document.querySelector('.app-header');
    if (header) document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  }

  // ---------- init ----------

  function isTypingTarget(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  }

  function bindEvents() {
    els.base.addEventListener('change', onControlChange);
    els.compare.addEventListener('change', onControlChange);
    [els.whitespace, els.quotes, els.punctuation, els.case, els.changed].forEach(function (cb) {
      cb.addEventListener('change', onControlChange);
    });
    els.swap.addEventListener('click', function () {
      var b = state.base; state.base = state.compare; state.compare = b;
      syncControlsFromState(); writeHash(); recompute();
    });
    els.prev.addEventListener('click', prevDiff);
    els.next.addEventListener('click', nextDiff);

    els.docTabs.addEventListener('click', function (e) {
      var tab = e.target.closest('.doc-tab');
      if (tab) switchDoc(tab.getAttribute('data-doc'));
    });

    // Number badges (rule ids and heading numbers) copy a permalink; clicking
    // the heading itself selects it (address bar + scroll).
    els.changes.addEventListener('click', function (e) {
      var link = e.target.closest('.link-id, .link-hnum');
      if (link) { e.preventDefault(); copyAnchorLink(link.getAttribute('data-anchor'), link); return; }
      var heading = e.target.closest('.drow.type-chapter, .drow.type-section');
      if (heading && heading.getAttribute('data-anchor')) selectAnchor(heading.getAttribute('data-anchor'));
    });

    // TOC entries scroll without clobbering the state params in the hash.
    els.toc.addEventListener('click', function (e) {
      var a = e.target.closest('a[data-anchor]');
      if (!a) return;
      e.preventDefault();
      selectAnchor(a.getAttribute('data-anchor'));
    });

    // Keep the current-difference indicator and sidebar highlight in sync with
    // the scroll position.
    var scrollScheduled = false;
    window.addEventListener('scroll', function () {
      if (scrollScheduled) return;
      scrollScheduled = true;
      requestAnimationFrame(function () {
        scrollScheduled = false;
        setCurrent(computeActiveIndex());
        updateTocSpy();
        // A manual scroll (not one of our programmatic nav jumps) invalidates the
        // Prev/Next cursor, so the next tap steps from where the user scrolled to.
        if (!navigating) navTargetIndex = null;
      });
    }, { passive: true });

    // Toggling the sidebar section list only re-renders the sidebar, not the diff.
    els.sections.addEventListener('change', function () {
      state.sections = els.sections.checked;
      writeHash();
      if (lastAlign) renderToc(lastAlign.rows);
      refreshTocSpy();
    });

    // Switching view mode re-renders from the same alignment — no recompute.
    [els.viewUni, els.viewSbs].forEach(function (rb) {
      rb.addEventListener('change', function () {
        state.view = els.viewSbs.checked ? 'sbs' : 'uni';
        writeHash();
        if (lastAlign) render();
      });
    });

    // Purely a CSS toggle — no re-render or recompute needed, the diff markup
    // and its normalized comparison are unaffected.
    els.emphasize.addEventListener('change', function () {
      state.emphasize = els.emphasize.checked;
      writeHash();
      applyEmphasizeClass();
    });

    els.settingsToggle.addEventListener('click', function () {
      var header = document.querySelector('.app-header');
      var open = header.classList.toggle('settings-open');
      els.settingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      // Header height changed → keep the sticky column labels positioned right.
      requestAnimationFrame(updateHeaderOffset);
    });

    // Clicking the title resets to a fresh comparison with a clean address bar.
    els.title.addEventListener('click', resetToDefaults);
    els.title.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resetToDefaults(); }
    });

    // The tagline's "changed" link: compare the latest year to the previous one.
    if (els.showChanged) els.showChanged.addEventListener('click', compareLatestToPrevious);

    document.addEventListener('keydown', function (e) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      var k = (e.key || '').toLowerCase();
      if (k === 'n') { e.preventDefault(); nextDiff(); }
      else if (k === 'p') { e.preventDefault(); prevDiff(); }
    });

    window.addEventListener('resize', debounce(updateHeaderOffset, 150));

    window.addEventListener('hashchange', function () {
      var params = readHash();
      if (!params) return;
      applyHash(params);
      if (els.showChanged) els.showChanged.disabled = years().length < 2;
      renderDocTabs(); syncControlsFromState();
      pendingAnchor = state.at;   // scroll to the linked heading after re-render
      recompute();
    });
  }

  function onControlChange() { readStateFromControls(); scheduleRecompute(); }

  // Reset everything to the first-visit state: default years/toggles, no anchor,
  // a clean address bar, and scrolled to the top.
  function resetToDefaults() {
    state.doc = 'rulebook';
    var ys = years();
    state.base = ys[ys.length - 1];
    state.compare = ys[ys.length - 1];
    state.view = 'sbs';
    state.changed = false;
    state.sections = true;
    state.emphasize = false;
    state.at = null;
    state.opts = { whitespace: true, quotes: true, punctuation: true, case: true };
    pendingAnchor = null;
    scheduleNavHashWrite.cancel();   // a pending nav write must not resurrect the hash

    history.replaceState(null, '', location.pathname + location.search);

    var header = document.querySelector('.app-header');
    if (header) header.classList.remove('settings-open');
    els.settingsToggle.setAttribute('aria-expanded', 'false');

    if (els.showChanged) els.showChanged.disabled = years().length < 2;
    renderDocTabs();
    syncControlsFromState();
    applyEmphasizeClass();
    recompute().then(function () { window.scrollTo({ top: 0, behavior: 'auto' }); });
  }

  // Switch straight to comparing the latest year against the one before it,
  // keeping the current document and other settings as they are.
  function compareLatestToPrevious() {
    var ys = years();
    if (ys.length < 2) return;
    state.base = ys[ys.length - 2];
    state.compare = ys[ys.length - 1];
    syncControlsFromState();
    writeHash();
    recompute();
  }

  function init() {
    // iOS: render the app header as position:fixed (see body.ios CSS). Fixed
    // needs no per-scroll positioning, so it cannot lag or flicker on
    // programmatic jumps the way sticky does in iOS Safari.
    if (IS_IOS) document.body.classList.add('ios');

    els = {
      base: $('base-select'), compare: $('compare-select'),
      whitespace: $('opt-whitespace'), quotes: $('opt-quotes'),
      punctuation: $('opt-punctuation'), case: $('opt-case'),
      changed: $('opt-changed'), sections: $('opt-sections'), emphasize: $('opt-emphasize'), swap: $('swap'),
      viewUni: $('view-uni'), viewSbs: $('view-sbs'),
      prev: $('prev-diff'), next: $('next-diff'), counter: $('diff-counter'),
      settingsToggle: $('settings-toggle'), title: $('app-title'), showChanged: $('show-changed'),
      versionMeta: $('version-meta'), docTabs: $('doc-tabs'),
      summary: $('summary'), toc: $('toc'), changes: $('changes')
    };

    loadManifest().then(function (manifest) {
      docs = manifest.docs.slice();
      // Default to reading the latest rulebook (base = compare); the tagline's
      // "changed" link switches to comparing it against the previous year.
      var ys = years();
      state.compare = ys[ys.length - 1];
      state.base = ys[ys.length - 1];

      var params = readHash();
      applyHash(params);
      // Only one year published for this document — nothing to compare yet.
      if (els.showChanged) els.showChanged.disabled = years().length < 2;
      pendingAnchor = state.at;   // honor a permalink's section/chapter anchor
      renderDocTabs();
      syncControlsFromState();
      applyEmphasizeClass();
      bindEvents();
      // Only touch the address bar if the URL already carried parameters; a
      // fresh open stays clean until the user changes something.
      if (params) writeHash();
      return recompute();
    }).then(updateHeaderOffset).catch(function (err) {
      $('changes').innerHTML = '<p class="empty-state">Failed to load manifest.json. ' +
        'Are you serving over HTTP? ' + escapeHtml(err.message) + '</p>';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
