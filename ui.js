/*
 * ui.js — wires the parser + normalizer + diff engine to the page. Vanilla DOM.
 *
 * The view is an IntelliJ-style, full-document side-by-side diff: both rulebooks
 * are rendered in full for context, with matching rules aligned on the same row
 * and changes highlighted in place. Prev/Next controls (and F7 / n / p) walk the
 * differences. State (years, toggles, filter) lives in the URL hash as a shareable
 * permalink.
 */
(function () {
  'use strict';

  var Parser = window.RulebookParser;
  var Diff = window.RulebookDiff;

  var els = {};
  var modelCache = new Map();   // year → parsed model
  var manifest = [];
  var lastAlign = null;

  // Navigation over the rendered difference rows.
  var diffEls = [];
  var currentDiff = -1;

  var state = {
    base: null,
    compare: null,
    changed: false,               // false = full document (context); true = only changes
    at: null,                     // anchor (chap-N / sec-N) reflected in the address bar
    opts: { whitespace: true, quotes: true, punctuation: false, case: false }
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
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function compareIds(a, b) {
    var pa = String(a).split(/[.\/]/);
    var pb = String(b).split(/[.\/]/);
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
    if (params.base && manifest.indexOf(params.base) >= 0) state.base = params.base;
    if (params.cmp && manifest.indexOf(params.cmp) >= 0) state.compare = params.cmp;
    if (params.changed !== undefined) state.changed = params.changed === '1';
    if (params.ws !== undefined) state.opts.whitespace = params.ws === '1';
    if (params.q !== undefined) state.opts.quotes = params.q === '1';
    if (params.p !== undefined) state.opts.punctuation = params.p === '1';
    if (params.c !== undefined) state.opts.case = params.c === '1';
    if (params.at) state.at = params.at;
  }

  function writeHash() {
    var o = state.opts;
    var parts = [
      'base=' + encodeURIComponent(state.base),
      'cmp=' + encodeURIComponent(state.compare),
      'changed=' + (state.changed ? '1' : '0'),
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

  function loadRulebook(year) {
    if (modelCache.has(year)) return Promise.resolve(modelCache.get(year));
    return fetch('rulebooks/IDPA-Rulebook-' + year + '.md')
      .then(function (r) { if (!r.ok) throw new Error('rulebook ' + year + ' ' + r.status); return r.text(); })
      .then(function (text) { var m = Parser.parseRulebook(text); modelCache.set(year, m); return m; });
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

  function syncControlsFromState() {
    fillSelect(els.base, manifest, state.base);
    fillSelect(els.compare, manifest, state.compare);
    els.whitespace.checked = state.opts.whitespace;
    els.quotes.checked = state.opts.quotes;
    els.punctuation.checked = state.opts.punctuation;
    els.case.checked = state.opts.case;
    els.changed.checked = state.changed;
  }

  function readStateFromControls() {
    state.base = els.base.value;
    state.compare = els.compare.value;
    state.opts.whitespace = els.whitespace.checked;
    state.opts.quotes = els.quotes.checked;
    state.opts.punctuation = els.punctuation.checked;
    state.opts.case = els.case.checked;
    state.changed = els.changed.checked;
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

  // Inner HTML for one cell of a row, on a given side ('left' | 'right').
  function cellInner(row, side) {
    var block = side === 'left' ? row.left : row.right;
    if (!block) return '';   // spacer opposite an add/remove

    var isHeading = block.type === 'chapter' || block.type === 'section';
    var textHtml;
    if (row.diff) {
      textHtml = side === 'left' ? diffLeftHtml(row.diff) : diffRightHtml(row.diff);
    } else {
      textHtml = escapeHtml(block.text);
    }

    if (block.type === 'chapter' || block.type === 'section') {
      return '<div class="cell-heading ' + block.type + '"><span class="hnum">' + escapeHtml(block.id) + '</span> ' +
        textHtml + headingButton(row, side) + '</div>';
    }
    return ruleIdHtml(row, block, side) + '<span class="cell-text">' + textHtml + '</span>';
  }

  // Every block has a unique alignment key (chap:2, sec:2.7, rule:2.12.3.3,
  // pre:2.9/preamble-1); turn it into a stable, URL-safe anchor. Chapters and
  // sections keep their existing chap-N / sec-N form for backward-compatible links.
  function anchorFor(block) { return block.key.replace(/[:#/]/g, '-'); }

  function rowAnchor(row) {
    var b = row.right || row.left;
    return b ? anchorFor(b) : null;
  }

  // A copy-link button on a heading row (rendered on the side that has the heading).
  function headingButton(row, side) {
    var primarySide = row.right ? 'right' : 'left';
    if (side !== primarySide) return '';
    var anchor = rowAnchor(row);
    var b = row.right || row.left;
    var label = 'Copy link to ' + row.type + ' ' + b.id;
    return ' <button type="button" class="link-btn" data-anchor="' + escapeHtml(anchor) +
      '" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">🔗</button>';
  }

  // The rule/preamble id badge is itself a copy-link (one per row, on the side
  // that carries the id). tabindex -1 keeps ~600 badges out of the tab order.
  function ruleIdHtml(row, block, side) {
    var isPre = block.type === 'preamble';
    var content = isPre ? '¶' : escapeHtml(block.id);
    var primarySide = row.right ? 'right' : 'left';
    if (side !== primarySide) {
      return '<span class="cell-id' + (isPre ? ' preamble' : '') + '">' + content + '</span>';
    }
    var anchor = rowAnchor(row);
    var label = 'Copy link to ' + (isPre ? 'this intro text' : 'rule ' + block.id);
    return '<button type="button" tabindex="-1" class="cell-id link-id' + (isPre ? ' preamble' : '') +
      '" data-anchor="' + escapeHtml(anchor) + '" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' +
      content + '</button>';
  }

  function rowHtml(row, index) {
    var anchorId = rowAnchor(row);
    var attrs = 'class="drow ' + row.kind + ' type-' + row.type + '"';
    if (anchorId) attrs += ' id="' + anchorId + '" data-anchor="' + escapeHtml(anchorId) + '"';
    if (row.kind !== 'unchanged') attrs += ' data-diff-index="' + index + '" data-kind="' + row.kind + '"';

    var leftEmpty = row.left ? '' : ' empty';
    var rightEmpty = row.right ? '' : ' empty';
    return '<div ' + attrs + '>' +
      '<div class="dcell left' + leftEmpty + '">' + cellInner(row, 'left') + '</div>' +
      '<div class="dcell right' + rightEmpty + '">' + cellInner(row, 'right') + '</div>' +
      '</div>';
  }

  function metaLine(year) {
    var m = modelCache.get(year);
    if (!m || !m.meta) return escapeHtml(year);
    var bits = [year];
    if (m.meta.version) bits.push('Ver. ' + m.meta.version);
    if (m.meta.amended) bits.push('amended ' + m.meta.amended);
    return escapeHtml(bits.join(' · '));
  }

  // ---------- main render ----------

  function render() {
    var al = lastAlign;
    var summary = al.summary;

    renderSummary(summary);
    renderToc(al.rows);

    var colHeader = '<div class="diff-colhead">' +
      '<div class="dcell left"><span class="col-tag">Base</span> ' + metaLine(state.base) + '</div>' +
      '<div class="dcell right"><span class="col-tag">Compare</span> ' + metaLine(state.compare) + '</div>' +
      '</div>';

    var warnings = warningsHtml();

    var diffIndex = 0;
    var body = al.rows.map(function (row) {
      // In "changed only" mode, drop unchanged rules/prose but keep chapter and
      // section headings so the remaining changes stay anchored to their place.
      if (state.changed && row.kind === 'unchanged' && (row.type === 'rule' || row.type === 'preamble')) return '';
      var idx = row.kind !== 'unchanged' ? diffIndex++ : -1;
      return rowHtml(row, idx);
    }).join('');

    if (!body) {
      els.changes.innerHTML = warnings + '<p class="empty-state">No differences to show with the current settings.</p>';
      resetNav();
      return;
    }

    els.changes.innerHTML = warnings + '<div class="diff-doc">' + colHeader + body + '</div>';

    // Rebuild the navigation list from what actually rendered.
    diffEls = Array.prototype.slice.call(els.changes.querySelectorAll('[data-diff-index]'));
    currentDiff = -1;
    updateHeaderOffset();

    // Restore a linked anchor (from a permalink or back/forward), then sync the
    // current-difference indicator to wherever the page ends up.
    if (pendingAnchor) { scrollToAnchor(pendingAnchor, 'auto'); pendingAnchor = null; }
    setCurrent(computeActiveIndex());
  }

  function renderSummary(summary) {
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

  function warningsHtml() {
    var msgs = [];
    [state.base, state.compare].forEach(function (y) {
      var m = modelCache.get(y);
      if (m && m.warnings && m.warnings.length) m.warnings.forEach(function (w) { msgs.push(y + ': ' + w); });
    });
    if (!msgs.length) return '';
    return '<div class="warnings"><strong>Source notes:</strong> ' + msgs.map(escapeHtml).join(' · ') + '</div>';
  }

  function renderToc(rows) {
    var counts = {};   // chapterNumber → { title, count }
    rows.forEach(function (row) {
      var ctx = row.right || row.left;
      if (!ctx.chapter) return;
      var n = ctx.chapter.number;
      if (!counts[n]) counts[n] = { number: n, title: ctx.chapter.title, count: 0 };
      if (row.kind !== 'unchanged') counts[n].count++;
    });
    var list = Object.keys(counts).map(function (k) { return counts[k]; })
      .filter(function (c) { return c.count > 0; })
      .sort(function (a, b) { return compareIds(a.number, b.number); });

    if (!list.length) { els.toc.innerHTML = ''; return; }
    var items = list.map(function (c) {
      return '<li><a href="#chap-' + escapeHtml(c.number) + '" data-anchor="chap-' + escapeHtml(c.number) + '">' +
        '<span>' + escapeHtml(c.number + ' ' + c.title) + '</span>' +
        '<span class="toc-count">' + c.count + '</span></a></li>';
    }).join('');
    els.toc.innerHTML = '<h2>Chapters with changes</h2><ul>' + items + '</ul>';
  }

  // ---------- navigation (scroll-position based) ----------

  // The reference line just below the sticky header + column labels; a row is
  // "current" once its top reaches this line.
  function topOffset() {
    var header = document.querySelector('.app-header');
    var colhead = els.changes.querySelector('.diff-colhead');
    var hb = header ? header.getBoundingClientRect().bottom : 0;
    var ch = colhead ? colhead.offsetHeight : 0;
    return hb + ch + 6;
  }

  function resetNav() { diffEls = []; currentDiff = -1; updateCounter(); }

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

  function scrollElToLine(el, behavior) {
    var y = window.scrollY + el.getBoundingClientRect().top - topOffset();
    window.scrollTo({ top: Math.max(0, y), behavior: behavior || 'auto' });
  }

  // Scroll to a difference AND record its anchor in the address bar, so Prev/Next
  // (and summary-chip jumps) keep the URL pointed at where you are.
  function goToDiff(el) {
    if (!el) return;
    var a = el.getAttribute('data-anchor');
    if (a) { state.at = a; writeHash(); }
    scrollElToLine(el);
  }

  function nextDiff() {
    if (!diffEls.length) return;
    var line = topOffset();
    for (var i = 0; i < diffEls.length; i++) {
      if (diffEls[i].getBoundingClientRect().top > line + 1) { goToDiff(diffEls[i]); return; }
    }
    goToDiff(diffEls[0]); // wrap to first
  }

  function prevDiff() {
    if (!diffEls.length) return;
    var line = topOffset();
    for (var i = diffEls.length - 1; i >= 0; i--) {
      if (diffEls[i].getBoundingClientRect().top < line - 1) { goToDiff(diffEls[i]); return; }
    }
    goToDiff(diffEls[diffEls.length - 1]); // wrap to last
  }

  function jumpToKind(kind) {
    for (var i = 0; i < diffEls.length; i++) {
      if (diffEls[i].getAttribute('data-kind') === kind) { goToDiff(diffEls[i]); return; }
    }
  }

  // ---------- section / chapter linking ----------

  function scrollToAnchor(anchor, behavior) {
    if (!anchor) return;
    var el = document.getElementById(anchor);
    if (el) scrollElToLine(el, behavior);
  }

  // Click a heading: reflect it in the address bar and scroll it into place.
  function selectAnchor(anchor) {
    state.at = anchor;
    writeHash();
    scrollToAnchor(anchor, 'auto');
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
    if (state.base === state.compare) {
      els.changes.innerHTML = '<p class="empty-state">Pick two different years to compare.</p>';
      els.summary.innerHTML = '';
      els.toc.innerHTML = '';
      resetNav();
      return Promise.resolve();
    }
    return Promise.all([loadRulebook(state.base), loadRulebook(state.compare)])
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

    // Heading links: copy button copies a permalink; clicking the heading itself
    // selects it (address bar + scroll).
    els.changes.addEventListener('click', function (e) {
      var link = e.target.closest('.link-btn, .link-id');
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

    // Keep the current-difference indicator in sync with the scroll position.
    var scrollScheduled = false;
    window.addEventListener('scroll', function () {
      if (scrollScheduled) return;
      scrollScheduled = true;
      requestAnimationFrame(function () { scrollScheduled = false; setCurrent(computeActiveIndex()); });
    }, { passive: true });

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

    document.addEventListener('keydown', function (e) {
      if (e.key === 'F7') { e.preventDefault(); e.shiftKey ? prevDiff() : nextDiff(); return; }
      if (isTypingTarget(e.target)) return;
      if (e.key === 'n' || e.key === 'j') { e.preventDefault(); nextDiff(); }
      else if (e.key === 'p' || e.key === 'k') { e.preventDefault(); prevDiff(); }
    });

    window.addEventListener('resize', debounce(updateHeaderOffset, 150));

    window.addEventListener('hashchange', function () {
      var params = readHash();
      if (!params) return;
      applyHash(params); syncControlsFromState();
      pendingAnchor = state.at;   // scroll to the linked heading after re-render
      recompute();
    });
  }

  function onControlChange() { readStateFromControls(); scheduleRecompute(); }

  // Reset everything to the first-visit state: default years/toggles, no anchor,
  // a clean address bar, and scrolled to the top.
  function resetToDefaults() {
    state.base = manifest.length > 1 ? manifest[manifest.length - 2] : manifest[0];
    state.compare = manifest[manifest.length - 1];
    state.changed = false;
    state.at = null;
    state.opts = { whitespace: true, quotes: true, punctuation: false, case: false };
    pendingAnchor = null;

    history.replaceState(null, '', location.pathname + location.search);

    var header = document.querySelector('.app-header');
    if (header) header.classList.remove('settings-open');
    els.settingsToggle.setAttribute('aria-expanded', 'false');

    syncControlsFromState();
    recompute().then(function () { window.scrollTo({ top: 0, behavior: 'auto' }); });
  }

  function init() {
    els = {
      base: $('base-select'), compare: $('compare-select'),
      whitespace: $('opt-whitespace'), quotes: $('opt-quotes'),
      punctuation: $('opt-punctuation'), case: $('opt-case'),
      changed: $('opt-changed'), swap: $('swap'),
      prev: $('prev-diff'), next: $('next-diff'), counter: $('diff-counter'),
      settingsToggle: $('settings-toggle'), title: $('app-title'),
      summary: $('summary'), toc: $('toc'), changes: $('changes')
    };

    loadManifest().then(function (years) {
      manifest = years.slice();
      state.compare = manifest[manifest.length - 1];
      state.base = manifest.length > 1 ? manifest[manifest.length - 2] : manifest[0];

      var params = readHash();
      applyHash(params);
      pendingAnchor = state.at;   // honor a permalink's section/chapter anchor
      syncControlsFromState();
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
