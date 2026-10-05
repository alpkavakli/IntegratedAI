// @ts-check
/**
 * Make injected CSS win specificity ties with the page's own rules.
 *
 * chrome.scripting.insertCSS adds an author stylesheet that does NOT win ties: if the
 * AI writes `.plan .badge { white-space: normal }` and the page has the same selector,
 * the page's rule wins and the fix silently does nothing.
 *
 * boostCss() adds `:not(#integratedai)` to every selector. That matches every element
 * (no element has that id) but counts as one ID in specificity, so our rules beat
 * ordinary page rules (classes, tags, a single ID plus classes) while page
 * `!important` declarations and inline styles still win, as they should.
 *
 *   .plan .badge                 → .plan .badge:not(#integratedai)
 *   a:hover, h1::before          → a:hover:not(#integratedai), h1:not(#integratedai)::before
 *   @media (…) { body { … } }    → @media (…) { body:not(#integratedai) { … } }
 *
 * Uses the browser's CSS parser (CSSStyleSheet), so it runs in extension pages
 * (the panel, options), not in the service worker. The CSS the user sees in cards
 * and patches stays as written; only the injected copy is boosted.
 */

const BOOST = ':not(#integratedai)';

/**
 * @param {string} css
 * @returns {string} the boosted CSS (or the input unchanged if it can't be parsed)
 */
export function boostCss(css) {
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    return css;
  }
  return [...sheet.cssRules].map(boostRule).join('\n');
}

/** @param {CSSRule} rule */
function boostRule(rule) {
  if (rule instanceof CSSStyleRule) {
    // Rules with nested rules (CSS nesting): boost the outer selector, keep the inside as written.
    const inner = rule.cssText.slice(rule.cssText.indexOf('{'));
    return `${boostSelectorList(rule.selectorText)} ${inner}`;
  }
  // Grouping rules (@media, @supports, @container, @layer { … }, @scope): boost what's inside.
  if ('cssRules' in rule && rule.cssRules && !(rule instanceof CSSKeyframesRule)) {
    const head = rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
    return `${head} {\n${[.../** @type {CSSRuleList} */ (rule.cssRules)].map(boostRule).join('\n')}\n}`;
  }
  return rule.cssText; // @keyframes, @font-face, @import, …
}

/**
 * Boost each selector of a comma-separated list (commas inside (), [] or quotes don't split).
 * @param {string} list
 */
export function boostSelectorList(list) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((s) => boostSelector(s.trim())).join(', ');
}

/**
 * Insert the boost before a trailing pseudo-element (nothing may follow one).
 * @param {string} selector
 */
function boostSelector(selector) {
  if (!selector || selector.includes(BOOST)) return selector;
  const pseudo = selector.match(/(::?(?:before|after|first-line|first-letter|marker|placeholder|selection|backdrop|file-selector-button|[a-z-]+\([^)]*\)))$/i);
  // Only `::xyz` (and the four legacy single-colon ones) are pseudo-elements; `:hover` etc. are not.
  if (pseudo && (pseudo[1].startsWith('::') || /^:(before|after|first-line|first-letter)$/i.test(pseudo[1]))) {
    return selector.slice(0, -pseudo[1].length) + BOOST + pseudo[1];
  }
  return selector + BOOST;
}
