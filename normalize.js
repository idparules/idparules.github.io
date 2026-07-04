/*
 * normalize.js — text normalization used ONLY to decide whether two pieces of
 * rule text differ. The UI always displays the original, verbatim text; these
 * transforms just collapse cosmetic differences so the diff can ignore them.
 *
 * Each step is independent and composable, toggled via the options object.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.Normalize = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    whitespace: true,   // collapse runs of whitespace to one space, trim
    quotes: true,       // smart quotes/dashes/nbsp → straight ASCII equivalents
    punctuation: false, // drop , . ; : ! ? quotes/apostrophes/brackets; hyphens compare as spaces
    case: false         // lowercase
  };

  function defaults() {
    return {
      whitespace: DEFAULTS.whitespace,
      quotes: DEFAULTS.quotes,
      punctuation: DEFAULTS.punctuation,
      case: DEFAULTS.case
    };
  }

  function withDefaults(options) {
    var o = options || {};
    return {
      whitespace: o.whitespace !== undefined ? !!o.whitespace : DEFAULTS.whitespace,
      quotes: o.quotes !== undefined ? !!o.quotes : DEFAULTS.quotes,
      punctuation: o.punctuation !== undefined ? !!o.punctuation : DEFAULTS.punctuation,
      case: o.case !== undefined ? !!o.case : DEFAULTS.case
    };
  }

  function normalizeQuotes(s) {
    return s
      .replace(/[‘’‚‛′]/g, "'")   // ‘ ’ ‚ ‛ ′ → '
      .replace(/[“”„‟″]/g, '"')   // “ ” „ ‟ ″ → "
      .replace(/[–—−]/g, '-')                // – — − → -
      .replace(/…/g, '...')                            // … → ...
      .replace(/[   ]/g, ' ');               // nbsp/thin/narrow → space
  }

  function stripPunctuation(s) {
    // Drop marks that don't change meaning: sentence punctuation, quotes and
    // apostrophes ("shooters" ↔ "shooters'"), brackets, footnote asterisks.
    // Hyphens and dashes become a space so hyphenation differences compare
    // equal ("Club-based" ↔ "Club based"). Slashes are deliberately kept:
    // "3/4" must not collide with "34".
    return s
      .replace(/[,.;:!?'"‘’‚‛′“”„‟″()[\]*]/g, '')
      .replace(/[-–—−]/g, ' ');
  }

  function collapseWhitespace(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  // Apply the enabled steps, in an order that keeps whitespace collapse last so
  // it cleans up any spacing left behind by earlier steps.
  function normalize(text, options) {
    var o = withDefaults(options);
    var s = text == null ? '' : String(text);
    if (o.quotes) s = normalizeQuotes(s);
    if (o.punctuation) s = stripPunctuation(s);
    if (o.case) s = s.toLowerCase();
    if (o.whitespace) s = collapseWhitespace(s);
    return s;
  }

  return {
    normalize: normalize,
    defaults: defaults,
    withDefaults: withDefaults,
    // exported for targeted testing
    _steps: {
      quotes: normalizeQuotes,
      punctuation: stripPunctuation,
      whitespace: collapseWhitespace
    }
  };
});
