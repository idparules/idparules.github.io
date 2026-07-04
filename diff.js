/*
 * diff.js — compare two parsed rulebook models and produce a change report.
 *
 * Alignment is by rule id (parser.rulesById). Equality is decided on NORMALIZED
 * text, but every word-level diff is computed on the ORIGINAL tokens so the UI
 * can display verbatim rule text (normalization is comparison-only).
 *
 * Depends on jsdiff (browser: global `Diff` from the CDN; Node: vendored copy)
 * and normalize.js.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./vendor/diff.js'), require('./normalize.js'));
  } else {
    root.RulebookDiff = factory(root.Diff, root.Normalize);
  }
})(typeof self !== 'undefined' ? self : this, function (Diff, Normalize) {
  'use strict';

  var normalize = Normalize.normalize;
  var MOVE_THRESHOLD = 0.95; // ≥95% similar → treat Added/Removed pair as a move

  // Split text into word and whitespace tokens, preserving originals exactly so
  // the rendered diff can be reassembled verbatim.
  function tokenize(text) {
    return String(text == null ? '' : text).match(/\s+|\S+/g) || [];
  }

  function tokenKey(tok, options) {
    return normalize(tok, options);
  }

  // Word-level diff on ORIGINAL tokens, with equality judged on normalized form.
  // Returns [{ value, added, removed }] where value is verbatim original text.
  function diffWordsNormalized(oldText, newText, options) {
    var a = tokenize(oldText);
    var b = tokenize(newText);
    var parts = Diff.diffArrays(a, b, {
      comparator: function (l, r) { return tokenKey(l, options) === tokenKey(r, options); }
    });
    return parts.map(function (p) {
      return { value: p.value.join(''), added: !!p.added, removed: !!p.removed };
    });
  }

  // Word-overlap similarity in [0,1] on normalized text, used for move detection.
  function similarity(aNorm, bNorm) {
    var aw = aNorm.split(' ').filter(Boolean);
    var bw = bNorm.split(' ').filter(Boolean);
    if (!aw.length && !bw.length) return 1;
    if (!aw.length || !bw.length) return 0;
    var parts = Diff.diffArrays(aw, bw, { comparator: function (l, r) { return l === r; } });
    var common = 0;
    parts.forEach(function (p) { if (!p.added && !p.removed) common += p.value.length; });
    return common / Math.max(aw.length, bw.length);
  }

  // Flatten a model into an ordered list of diffable entries, each carrying its
  // chapter/section context for grouping. Order: chapter preamble, then each
  // section's preamble followed by its rules.
  function buildEntries(model) {
    var entries = [];
    model.chapters.forEach(function (ch) {
      var chapterCtx = { chapterNumber: ch.number, chapterTitle: ch.title };
      (ch.preamble || []).forEach(function (e) {
        entries.push(withCtx(e, chapterCtx, null));
      });
      (ch.sections || []).forEach(function (sec) {
        var secCtx = { sectionNumber: sec.number, sectionTitle: sec.title };
        (sec.preamble || []).forEach(function (e) { entries.push(withCtx(e, chapterCtx, secCtx)); });
        (sec.rules || []).forEach(function (e) { entries.push(withCtx(e, chapterCtx, secCtx)); });
      });
    });
    return entries;
  }

  function withCtx(entry, chapterCtx, secCtx) {
    return {
      key: entry.key,
      id: entry.id,
      type: entry.type,
      text: entry.text,
      src: entry.src,
      raw: entry.raw,
      chapter: { number: chapterCtx.chapterNumber, title: chapterCtx.chapterTitle },
      section: secCtx ? { number: secCtx.sectionNumber, title: secCtx.sectionTitle } : null
    };
  }

  function indexBy(entries) {
    var map = new Map();
    entries.forEach(function (e) { map.set(e.key, e); });
    return map;
  }

  function compareRulebooks(oldModel, newModel, options) {
    var opts = Normalize.withDefaults(options);

    var oldEntries = buildEntries(oldModel);
    var newEntries = buildEntries(newModel);
    var oldByKey = indexBy(oldEntries);
    var newByKey = indexBy(newEntries);

    var changes = [];
    var addedCandidates = [];
    var removedCandidates = [];

    // Pass 1 — walk the NEW model in document order, classifying each entry.
    newEntries.forEach(function (ne) {
      var oe = oldByKey.get(ne.key);
      if (!oe) {
        addedCandidates.push(ne);
        return;
      }
      var same = normalize(oe.text, opts) === normalize(ne.text, opts);
      if (same) {
        changes.push(makeChange('unchanged', ne.type, ne, oe, null, opts));
      } else {
        changes.push(makeChange('modified', ne.type, ne, oe, null, opts));
      }
    });

    // Pass 1b — old entries with no matching new key are removal candidates.
    oldEntries.forEach(function (oe) {
      if (!newByKey.has(oe.key)) removedCandidates.push(oe);
    });

    // Pass 2 — move detection: pair a removed with an added whose normalized
    // text is identical or ≥95% similar. Greedy, best matches first.
    var moves = detectMoves(removedCandidates, addedCandidates, opts);
    var movedRemovedKeys = new Set();
    var movedAddedKeys = new Set();
    moves.forEach(function (m) {
      movedRemovedKeys.add(m.removed.key);
      movedAddedKeys.add(m.added.key);
    });

    // Emit added (non-moved) and moved entries at their NEW-model position.
    var finalChanges = [];
    var moveByAddedKey = new Map();
    moves.forEach(function (m) { moveByAddedKey.set(m.added.key, m); });

    newEntries.forEach(function (ne) {
      var oe = oldByKey.get(ne.key);
      if (oe) {
        // already classified as unchanged/modified in `changes`
        var c = changes.find(function (x) { return x.newKey === ne.key && x.entryType === ne.type; });
        if (c) finalChanges.push(c);
      } else if (moveByAddedKey.has(ne.key)) {
        var mv = moveByAddedKey.get(ne.key);
        finalChanges.push(makeChange('moved', ne.type, ne, mv.removed, null, opts));
      } else {
        finalChanges.push(makeChange('added', ne.type, ne, null, null, opts));
      }
    });

    // Removed (non-moved) appended in old-model order.
    removedCandidates.forEach(function (oe) {
      if (!movedRemovedKeys.has(oe.key)) {
        finalChanges.push(makeChange('removed', oe.type, null, oe, null, opts));
      }
    });

    // Chapter & section title changes.
    var structural = compareStructure(oldModel, newModel, opts);
    finalChanges = structural.concat(finalChanges);

    var summary = summarize(finalChanges);
    return { summary: summary, changes: finalChanges, options: opts };
  }

  function detectMoves(removedList, addedList, opts) {
    var pairs = [];
    removedList.forEach(function (rem) {
      var remNorm = normalize(rem.text, opts);
      addedList.forEach(function (add) {
        var sim = similarity(remNorm, normalize(add.text, opts));
        if (sim >= MOVE_THRESHOLD) pairs.push({ removed: rem, added: add, sim: sim });
      });
    });
    pairs.sort(function (a, b) { return b.sim - a.sim; });
    var usedRem = new Set(), usedAdd = new Set(), moves = [];
    pairs.forEach(function (p) {
      if (usedRem.has(p.removed.key) || usedAdd.has(p.added.key)) return;
      usedRem.add(p.removed.key);
      usedAdd.add(p.added.key);
      moves.push(p);
    });
    return moves;
  }

  function compareStructure(oldModel, newModel, opts) {
    var out = [];

    var oldCh = {}, newCh = {};
    oldModel.chapters.forEach(function (c) { oldCh[c.number] = c; });
    newModel.chapters.forEach(function (c) { newCh[c.number] = c; });

    newModel.chapters.forEach(function (c) {
      var o = oldCh[c.number];
      if (o && normalize(o.title, opts) !== normalize(c.title, opts)) {
        out.push(titleChange('chapter', c.number, o.title, c.title, { number: c.number, title: c.title }, null, opts));
      }
    });

    var oldSec = {}, secCtxByNum = {};
    oldModel.chapters.forEach(function (c) {
      (c.sections || []).forEach(function (s) { oldSec[s.number] = s; });
    });
    newModel.chapters.forEach(function (c) {
      (c.sections || []).forEach(function (s) {
        var o = oldSec[s.number];
        if (o && normalize(o.title, opts) !== normalize(s.title, opts)) {
          out.push(titleChange('section', s.number, o.title, s.title,
            { number: c.number, title: c.title }, { number: s.number, title: s.title }, opts));
        }
      });
    });

    return out;
  }

  function titleChange(entryType, number, oldTitle, newTitle, chapter, section, opts) {
    return {
      kind: 'modified',
      entryType: entryType,
      id: number,
      oldId: number,
      newId: number,
      oldKey: number,
      newKey: number,
      chapter: chapter,
      section: section,
      oldText: oldTitle,
      newText: newTitle,
      diff: diffWordsNormalized(oldTitle, newTitle, opts)
    };
  }

  function makeChange(kind, entryType, newEntry, oldEntry, _unused, opts) {
    var ctxSource = newEntry || oldEntry;
    var change = {
      kind: kind,
      entryType: entryType,
      id: (newEntry || oldEntry).id,
      oldId: oldEntry ? oldEntry.id : null,
      newId: newEntry ? newEntry.id : null,
      oldKey: oldEntry ? oldEntry.key : null,
      newKey: newEntry ? newEntry.key : null,
      chapter: ctxSource.chapter,
      section: ctxSource.section,
      oldText: oldEntry ? oldEntry.text : null,
      newText: newEntry ? newEntry.text : null,
      diff: null
    };
    if (kind === 'modified' || kind === 'moved') {
      change.diff = diffWordsNormalized(oldEntry.text, newEntry.text, opts);
    }
    return change;
  }

  function summarize(changes) {
    var s = { added: 0, removed: 0, modified: 0, moved: 0, unchanged: 0, total: 0 };
    changes.forEach(function (c) {
      if (s[c.kind] !== undefined) s[c.kind]++;
      if (c.kind !== 'unchanged') s.total++;
    });
    return s;
  }

  // ---------- full-document alignment (IntelliJ-style side-by-side) ----------

  // Flatten a model into an ordered list of blocks that includes chapter and
  // section headings alongside rules and preamble prose, so the whole document
  // can be rendered with structure. Each block has a stable alignment `key`.
  function entryBlock(e, chapterCtx, secCtx) {
    var prefix = e.type === 'rule' ? 'rule:' : e.type === 'figure' ? 'fig:' : 'pre:';
    return {
      key: prefix + e.key,
      type: e.type, id: e.id, text: e.text, src: e.src, raw: e.raw,
      chapter: chapterCtx, section: secCtx
    };
  }

  function buildBlocks(model) {
    var out = [];
    model.chapters.forEach(function (ch) {
      var chapterCtx = { number: ch.number, title: ch.title };
      out.push({ key: 'chap:' + ch.number, type: 'chapter', id: ch.number, text: ch.title, chapter: chapterCtx, section: null });
      (ch.preamble || []).forEach(function (e) { out.push(entryBlock(e, chapterCtx, null)); });
      (ch.sections || []).forEach(function (sec) {
        var secCtx = { number: sec.number, title: sec.title };
        out.push({ key: 'sec:' + sec.number, type: 'section', id: sec.number, text: sec.title, chapter: chapterCtx, section: secCtx });
        (sec.preamble || []).forEach(function (e) { out.push(entryBlock(e, chapterCtx, secCtx)); });
        (sec.rules || []).forEach(function (e) { out.push(entryBlock(e, chapterCtx, secCtx)); });
      });
    });
    return out;
  }

  // Produce an ordered list of aligned rows for a two-column, full-context diff.
  // Blocks present in both (matched by key) sit on one row — unchanged, or
  // modified with a word-level diff. Blocks only on one side are removed
  // (left-only) or added (right-only), keeping document order. Renumbered rules
  // (different id) therefore appear as a removed row and an added row, which is
  // how a positional side-by-side viewer shows a move.
  function alignDocuments(oldModel, newModel, options) {
    var opts = Normalize.withDefaults(options);
    var oldB = buildBlocks(oldModel);
    var newB = buildBlocks(newModel);
    var parts = Diff.diffArrays(
      oldB.map(function (b) { return b.key; }),
      newB.map(function (b) { return b.key; }),
      { comparator: function (l, r) { return l === r; } }
    );

    var rows = [];
    var oi = 0, ni = 0;
    parts.forEach(function (part) {
      var n = part.value.length;
      var k;
      if (part.added) {
        for (k = 0; k < n; k++) { rows.push({ kind: 'added', type: newB[ni].type, left: null, right: newB[ni], diff: null }); ni++; }
      } else if (part.removed) {
        for (k = 0; k < n; k++) { rows.push({ kind: 'removed', type: oldB[oi].type, left: oldB[oi], right: null, diff: null }); oi++; }
      } else {
        for (k = 0; k < n; k++) {
          var l = oldB[oi], r = newB[ni];
          var changed = normalize(l.text, opts) !== normalize(r.text, opts);
          rows.push({
            kind: changed ? 'modified' : 'unchanged',
            type: r.type, left: l, right: r,
            diff: changed ? diffWordsNormalized(l.text, r.text, opts) : null
          });
          oi++; ni++;
        }
      }
    });

    var summary = { added: 0, removed: 0, modified: 0, unchanged: 0, total: 0 };
    rows.forEach(function (rw) { summary[rw.kind]++; if (rw.kind !== 'unchanged') summary.total++; });

    return { rows: rows, summary: summary, options: opts };
  }

  return {
    compareRulebooks: compareRulebooks,
    alignDocuments: alignDocuments,
    buildBlocks: buildBlocks,
    diffWordsNormalized: diffWordsNormalized,
    similarity: similarity,
    tokenize: tokenize,
    MOVE_THRESHOLD: MOVE_THRESHOLD
  };
});
