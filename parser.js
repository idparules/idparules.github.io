/*
 * parser.js — parse a strictly-formatted IDPA rulebook Markdown file into a
 * structured model. Works both in the browser (attaches to window.RulebookParser)
 * and in Node (module.exports), so the same code powers the app and the tests.
 *
 * See docs/CONVERSION-PROMPT.md for the guaranteed source format.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.RulebookParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CHAPTER_RE = /^#\s+(\d+)\s+(.+?)\s*$/;
  var SECTION_RE = /^##\s+(\d+\.\d+)\s+(.+?)\s*$/;
  var CONTENTS_RE = /^##\s+Contents\s*$/i;
  // A rule paragraph starts with a dotted number token: 1.1, 2.9.1, 2.9.1.1 …
  var RULE_RE = /^(\d+(?:\.\d+)+)(?:\s+([\s\S]*))?$/;

  // Split a document into blocks separated by one or more blank lines.
  function toBlocks(text) {
    var lines = text.replace(/\r\n?/g, '\n').split('\n');
    var blocks = [];
    var current = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.trim() === '') {
        if (current.length) { blocks.push(current); current = []; }
      } else {
        current.push(line);
      }
    }
    if (current.length) blocks.push(current);
    return blocks;
  }

  // Best-effort parse of the title block that precedes "## Contents".
  function parseMeta(headLines) {
    var meta = { title: '', version: '', adopted: '', amended: '' };
    var text = headLines.join('\n');

    // Title: first non-empty line, stripped of markdown emphasis / heading marks.
    for (var i = 0; i < headLines.length; i++) {
      var t = headLines[i].replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
      if (t) { meta.title = t; break; }
    }

    var ver = text.match(/Ver\.\s*([^\n]+)/i);
    if (ver) meta.version = ver[1].trim();

    var adopted = text.match(/Adopted\s+([^,\n]+)/i);
    if (adopted) meta.adopted = adopted[1].trim();

    var amended = text.match(/amended\s+([^\n]+)/i);
    if (amended) meta.amended = amended[1].trim().replace(/[.]$/, '');

    return meta;
  }

  // Parse Contents list entries out of the given blocks (heading + list blocks,
  // which the source separates with blank lines). Entries look like
  // "2. SAFETY RULES — 4" (the "— <page>" pointer is stripped).
  function parseContents(blocks, startIdx, endIdx) {
    var entries = [];
    for (var i = startIdx; i < endIdx; i++) {
      var block = blocks[i];
      for (var j = 0; j < block.length; j++) {
        var m = block[j].match(/^(\d+)\.\s+(.+?)(?:\s+—\s+\d+)?\s*$/);
        if (m) entries.push({ number: m[1], title: m[2].trim() });
      }
    }
    return entries;
  }

  function isChapterHeading(line) {
    return CHAPTER_RE.test(line) && !SECTION_RE.test(line);
  }

  function parseRulebook(markdownText) {
    var blocks = toBlocks(markdownText || '');
    var warnings = [];

    // Locate the "## Contents" block. The title/meta block precedes it, the
    // Contents list follows it (as separate blocks), and real chapters only
    // begin at the first "# N …" heading after Contents — which keeps the H1
    // title line ("# 2025 IDPA Rulebook") from being mistaken for a chapter.
    var contentsIdx = -1;
    for (var b = 0; b < blocks.length; b++) {
      if (blocks[b].some(function (l) { return CONTENTS_RE.test(l); })) { contentsIdx = b; break; }
    }

    // The first real chapter heading after Contents (or after the title, if a
    // file has no Contents block).
    var firstChapterIdx = -1;
    for (var c = (contentsIdx < 0 ? 1 : contentsIdx + 1); c < blocks.length; c++) {
      if (isChapterHeading(blocks[c][0])) { firstChapterIdx = c; break; }
    }
    if (firstChapterIdx < 0) firstChapterIdx = blocks.length;

    var headLines = [];
    for (var hh = 0; hh < Math.min(contentsIdx < 0 ? firstChapterIdx : contentsIdx, blocks.length); hh++) {
      headLines = headLines.concat(blocks[hh]);
    }
    var meta = parseMeta(headLines);
    var contents = contentsIdx < 0 ? [] : parseContents(blocks, contentsIdx, firstChapterIdx);

    var model = {
      meta: meta,
      contents: contents,
      chapters: [],
      rulesById: new Map(),
      warnings: warnings
    };

    var currentChapter = null;
    var currentSection = null;
    var preambleCounters = new Map(); // scopeKey -> count

    // Register a rule/preamble into the O(1) alignment map, disambiguating the
    // rare duplicate id (a known source artifact) with a "#dupN" suffix so both
    // survive and still line up across files (they appear in the same order).
    function register(entry) {
      var key = entry.id;
      if (model.rulesById.has(key)) {
        var n = 2;
        while (model.rulesById.has(entry.id + '#dup' + n)) n++;
        key = entry.id + '#dup' + n;
        entry.key = key;
        warnings.push('Duplicate rule id "' + entry.id + '" — kept as "' + key + '".');
      } else {
        entry.key = key;
      }
      model.rulesById.set(key, entry);
    }

    function scopeKey() {
      if (currentSection) return currentSection.number;
      if (currentChapter) return currentChapter.number;
      return 'doc';
    }

    for (var i = firstChapterIdx; i < blocks.length; i++) {
      var block = blocks[i];
      var first = block[0];
      var raw = block.join('\n');

      var cm = first.match(CHAPTER_RE);
      var sm = first.match(SECTION_RE);

      if (cm && !sm) {
        currentChapter = { number: cm[1], title: cm[2].trim(), sections: [], preamble: [] };
        currentSection = null;
        model.chapters.push(currentChapter);
        continue;
      }

      if (sm) {
        if (!currentChapter) {
          warnings.push('Section "' + sm[1] + '" appeared before any chapter; skipped.');
          continue;
        }
        currentSection = { number: sm[1], title: sm[2].trim(), rules: [], preamble: [] };
        currentChapter.sections.push(currentSection);
        continue;
      }

      // Everything from the first chapter on is either a rule or preamble prose.
      var rm = first.match(RULE_RE);
      if (rm) {
        var id = rm[1];
        var firstRest = rm[2] || '';
        var rest = [firstRest].concat(block.slice(1)).join(' ').replace(/\s+/g, ' ').trim();
        var entry = { id: id, key: id, text: rest, raw: raw, type: 'rule' };
        if (currentSection) currentSection.rules.push(entry);
        else if (currentChapter) currentChapter.preamble.push(entry);
        register(entry);
      } else if (currentChapter) {
        // Prose paragraph without a rule number → preamble entry so it still diffs.
        var sk = scopeKey();
        var count = (preambleCounters.get(sk) || 0) + 1;
        preambleCounters.set(sk, count);
        var pid = sk + '/preamble-' + count;
        var pentry = { id: pid, key: pid, text: raw.replace(/\s+/g, ' ').trim(), raw: raw, type: 'preamble' };
        if (currentSection) currentSection.preamble.push(pentry);
        else currentChapter.preamble.push(pentry);
        register(pentry);
      } else {
        warnings.push('Unrecognized block before any chapter: ' + JSON.stringify(first.slice(0, 60)));
      }
    }

    return model;
  }

  return { parseRulebook: parseRulebook };
});
