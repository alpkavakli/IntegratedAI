// @ts-nocheck
/**
 * Functions that run INSIDE the inspected page (via callInPage in inspected.js).
 *
 * Rules for this file:
 *  - Each exported function is converted to text and evaluated in the page, so
 *    it must be self-contained: no imports, no variables from this module.
 *  - Shared helpers live in pageHelpers() and are passed in as the first argument `h`.
 *  - Return plain JSON-serializable data.
 *
 * State that must survive between calls (undo snapshots, preview state) is kept
 * on a hidden window property: window[Symbol.for('integratedai.state')].
 */

/** Helpers available to every page function as `h`. */
export function pageHelpers() {
  const MAX_HTML = 1500;

  // Computed style values that are almost always uninteresting.
  const BORING = new Set([
    'none', 'normal', 'auto', '0px', 'static', 'visible', '0s', 'baseline', 'start', 'ltr',
    'rgba(0, 0, 0, 0)', 'medium', 'repeat', 'scroll', 'border-box padding-box', 'content-box',
  ]);

  // Properties included in the default (small) context for the selected element.
  const KEY_PROPERTIES = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'box-sizing',
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'margin', 'padding', 'border', 'border-radius', 'box-shadow',
    'overflow', 'overflow-x', 'overflow-y', 'text-overflow', 'white-space', 'word-break',
    'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap',
    'grid-template-columns', 'grid-template-rows',
    'color', 'background-color', 'background-image', 'opacity', 'visibility', 'transform',
    'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
  ];

  /** Short, unique-if-possible CSS selector for an element. */
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    const unique = (sel) => {
      try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
    };
    if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
      if (node.id && unique(`#${CSS.escape(node.id)}`)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.localName;
      // Skip classes that look generated or stateful (hashes, "is-active", …).
      const classes = [...node.classList]
        .filter((c) => !/^(is-|has-|js-)|[0-9a-f]{5,}|__[a-z0-9]{5}|[:[\]/]/i.test(c))
        .slice(0, 2);
      if (classes.length) part += `.${classes.map((c) => CSS.escape(c)).join('.')}`;
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.localName === node.localName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (unique(parts.join(' > '))) break;
      node = parent;
    }
    return parts.join(' > ');
  }

  /** "div#main.card" style label. */
  function label(el) {
    if (!(el instanceof Element)) return '';
    return `${el.localName}${el.id ? `#${el.id}` : ''}${[...el.classList].slice(0, 3).map((c) => `.${c}`).join('')}`;
  }

  /** Computed styles, optionally only some properties, skipping boring values. */
  function computed(el, properties) {
    const cs = getComputedStyle(el);
    const names = properties || [...cs];
    // Flex/grid container properties only matter on flex/grid containers,
    // and `flex` (item sizing) only on children of one.
    const isContainer = /flex|grid/.test(cs.display);
    const parentDisplay = el.parentElement ? getComputedStyle(el.parentElement).display : '';
    const out = {};
    for (const name of names) {
      const value = cs.getPropertyValue(name);
      if (!value || BORING.has(value)) continue;
      if (name === 'opacity' && value === '1') continue;
      if (name === 'text-overflow' && value === 'clip') continue;
      if (/^border/.test(name) && /^0px none/.test(value)) continue;
      if (/^(flex-direction|flex-wrap|justify-content|align-items|gap|grid-template)/.test(name) && !isContainer) continue;
      if (name === 'flex' && (!/flex/.test(parentDisplay) || value === '0 1 auto')) continue;
      out[name] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
    return out;
  }

  function rect(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }

  /** Overflow facts: content size vs visible size. */
  function overflowInfo(el) {
    const info = { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    info.overflowsX = el.scrollWidth > el.clientWidth + 1;
    info.overflowsY = el.scrollHeight > el.clientHeight + 1;
    return info;
  }

  /** outerHTML, shortened: long text cut, deep children replaced by "…". */
  function htmlExcerpt(el, max = MAX_HTML) {
    let html = el.outerHTML;
    if (html.length <= max) return html;
    const open = html.slice(0, html.indexOf('>') + 1);
    const kids = [...el.children].slice(0, 8).map((c) => `  <${label(c)}>…`).join('\n');
    const more = el.children.length > 8 ? `\n  … ${el.children.length - 8} more children` : '';
    return `${open.slice(0, max)}\n${kids}${more}\n</${el.localName}>`;
  }

  /** Make any value JSON-safe and reasonably small. */
  function toJson(value) {
    try {
      if (value === undefined) return null;
      if (value instanceof Element) return { element: cssPath(value) };
      const text = JSON.stringify(value);
      if (text === undefined) return String(value);
      return text.length > 20000 ? `${text.slice(0, 20000)}…` : JSON.parse(text);
    } catch {
      return String(value);
    }
  }

  /** Find the target element: by selector, or the selected element ($0). */
  function target(selector, selected) {
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`No element matches ${selector}`);
      return el;
    }
    if (!(selected instanceof Element)) throw new Error('No element is selected in the Elements panel');
    return selected;
  }

  /** Hidden per-page state shared between calls. */
  function state() {
    const KEY = Symbol.for('integratedai.state');
    if (!window[KEY]) Object.defineProperty(window, KEY, { value: { snapshots: {} }, enumerable: false });
    return window[KEY];
  }

  return { KEY_PROPERTIES, cssPath, label, computed, rect, overflowInfo, htmlExcerpt, toJson, target, state };
}

// ───────────────────────────────────────────────────────────── context

/** Basic facts about the page. */
export function pageInfo() {
  return {
    url: location.href,
    title: document.title,
    timeOrigin: performance.timeOrigin, // changes on every page load; used to expire undo info
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
  };
}

/** One-line label of the selected element (for the "$0" chip). */
export function selectedLabel(h, selected) {
  if (!(selected instanceof Element)) return null;
  return { label: h.label(selected), selector: h.cssPath(selected) };
}

/** The visible text of the selected element ($0), for "Copy text"; null if nothing is selected. */
export function selectedText(h, selected) {
  if (!(selected instanceof Element)) return null;
  return (selected.innerText ?? selected.textContent ?? '').trim();
}

/** The small default context for the selected element ($0). */
export function describeSelected(h, selected) {
  if (!(selected instanceof Element)) return null;
  const el = selected;
  const parent = el.parentElement;
  const text = (el.innerText || '').trim();
  return {
    selector: h.cssPath(el),
    element: h.label(el),
    box: h.rect(el),
    computed: h.computed(el, h.KEY_PROPERTIES),
    overflow: h.overflowInfo(el),
    parent: parent
      ? {
        selector: h.cssPath(parent),
        box: h.rect(parent),
        computed: h.computed(parent, ['display', 'position', 'width', 'overflow', 'flex-direction', 'grid-template-columns', 'gap']),
      }
      : null,
    childCount: el.children.length,
    text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
    html: h.htmlExcerpt(el),
  };
}

// ───────────────────────────────────────────────────────────── inspections

/** inspect_element: details on request. */
export function inspectElement(h, selected, input) {
  const el = h.target(input.selector, selected);
  const include = new Set(input.include || []);
  const out = { selector: h.cssPath(el), element: h.label(el), box: h.rect(el) };

  if (include.has('computed_all')) out.computed = h.computed(el);

  if (include.has('rules')) {
    // Walk all same-origin stylesheets and collect rules whose selector matches.
    const rules = [];
    let skippedSheets = 0;
    const visit = (ruleList, sheetHref, media) => {
      for (const rule of ruleList) {
        if (rules.length >= 40) return;
        if (rule instanceof CSSStyleRule) {
          let matches = false;
          try { matches = el.matches(rule.selectorText); } catch { /* invalid selector */ }
          if (matches) rules.push({ selector: rule.selectorText, css: rule.style.cssText.slice(0, 600), source: sheetHref, media });
          if (rule.cssRules?.length) visit(rule.cssRules, sheetHref, media); // CSS nesting
        } else if (rule instanceof CSSMediaRule) {
          if (matchMedia(rule.conditionText).matches) visit(rule.cssRules, sheetHref, rule.conditionText);
        } else if (rule.cssRules) {
          visit(rule.cssRules, sheetHref, media); // @supports, @layer, @container …
        }
      }
    };
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
      try {
        visit(sheet.cssRules, sheet.href || 'inline <style>', undefined);
      } catch {
        skippedSheets++; // cross-origin stylesheet without CORS: rules not readable
      }
    }
    out.rules = rules;
    out.inlineStyle = el.getAttribute('style') || '';
    if (skippedSheets) out.note = `${skippedSheets} cross-origin stylesheet(s) could not be read; use inspect_resources to read their source.`;
  }

  if (include.has('ancestors')) {
    out.ancestors = [];
    for (let node = el.parentElement; node && out.ancestors.length < 8; node = node.parentElement) {
      out.ancestors.push({
        selector: h.cssPath(node),
        box: h.rect(node),
        computed: h.computed(node, ['display', 'position', 'width', 'max-width', 'height', 'overflow', 'overflow-x', 'flex-direction', 'flex-wrap', 'grid-template-columns', 'min-width', 'contain']),
        overflow: h.overflowInfo(node),
      });
      if (node === document.body) break;
    }
  }

  if (include.has('children')) {
    out.children = [...el.children].slice(0, 30).map((c) => ({
      selector: h.cssPath(c),
      box: h.rect(c),
      computed: h.computed(c, ['display', 'position', 'width', 'min-width', 'flex', 'white-space']),
    }));
  }

  if (include.has('html')) out.html = h.htmlExcerpt(el, 6000);
  return out;
}

/**
 * find_elements: search by selector and/or visible text. Without either,
 * list the page landmarks so the model can find the header/nav/footer.
 */
export function findElements(h, selected, input) {
  const limit = Math.min(Math.max(input.limit || 15, 1), 50);
  const selector = input.selector
    || (input.text ? '*' : 'header, nav, main, footer, aside, [role="banner"], [role="navigation"], [role="main"], [role="contentinfo"]');
  let candidates;
  try {
    candidates = [...document.body.querySelectorAll(selector)];
  } catch {
    throw new Error(`Invalid selector: ${selector}`);
  }

  if (input.text) {
    const needle = input.text.toLowerCase();
    // Match where the text actually lives: the element's own text nodes, or its value/label.
    const own = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')
      + ` ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.value || ''} ${el.getAttribute('placeholder') || ''}`;
    candidates = candidates.filter((el) => own(el).toLowerCase().includes(needle));
  }
  const skip = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link']);
  candidates = candidates.filter((el) => !skip.has(el.localName));

  return {
    total: candidates.length,
    matches: candidates.slice(0, limit).map((el) => {
      const box = h.rect(el);
      const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
      return {
        selector: h.cssPath(el),
        element: h.label(el),
        box,
        visible: box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden',
        children: el.children.length,
        text: text.length > 80 ? `${text.slice(0, 80)}…` : text,
      };
    }),
  };
}

/** inspect_console: read the buffer filled by content/console-capture.js. */
export function readConsole(h, selected, input) {
  const buffer = window[Symbol.for('integratedai.console')];
  if (!buffer) return { available: false, note: 'Console capture is not active on this page (reload the page after installing the extension).' };
  const levels = input.levels?.length ? new Set(input.levels) : null;
  const limit = Math.min(Math.max(input.limit || 20, 1), 100);
  const entries = buffer.entries.filter(
    (e) => (!levels || levels.has(e.level)) && (!input.contains || e.message.includes(input.contains)),
  );
  return { available: true, total: entries.length, entries: entries.slice(-limit) };
}

/**
 * screenshot, step 1: where is the target on screen? An element that is completely
 * off-screen is scrolled into view (restoreScroll puts the page back afterwards).
 * Without a selector or selected element, the visible page is captured.
 */
export function prepareScreenshot(h, selected, input) {
  const viewport = { width: innerWidth, height: innerHeight };
  const scroll = { x: scrollX, y: scrollY };
  if (input.fullViewport || (!input.selector && !(selected instanceof Element))) {
    return { viewport, scroll, scrolled: false, rect: null, label: 'the visible page' };
  }
  const el = h.target(input.selector, selected);
  let r = el.getBoundingClientRect();
  if (!r.width || !r.height) throw new Error(`${h.cssPath(el)} has no visible size (hidden or empty)`);
  let scrolled = false;
  if (r.bottom <= 0 || r.top >= viewport.height || r.right <= 0 || r.left >= viewport.width) {
    el.scrollIntoView({ block: r.height > viewport.height ? 'start' : 'center', inline: 'nearest' });
    scrolled = true;
    r = el.getBoundingClientRect();
  }
  return {
    viewport, scroll, scrolled,
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    selector: h.cssPath(el),
    label: h.label(el),
  };
}

/** screenshot, step 3: undo the scroll from prepareScreenshot. */
export function restoreScroll(h, selected, { x, y }) {
  scrollTo(x, y);
  return true;
}

// ───────────────────────────────────────────────────────────── modifications

/**
 * modify_element: apply safe changes to one element and keep a snapshot for undo.
 * Validation (no on* attributes, no javascript: URLs) already happened in the panel.
 */
export function applyModify(h, selected, { actionId, input }) {
  const el = h.target(input.selector, selected);
  const snapshot = {
    el,
    style: el.getAttribute('style'),
    className: el.getAttribute('class'),
    attributes: {},
    childNodes: null,
  };

  for (const { property, value, important } of input.setStyles || []) {
    el.style.setProperty(property, value, important ? 'important' : '');
  }
  for (const property of input.removeStyles || []) el.style.removeProperty(property);

  for (const { name, value } of input.setAttributes || []) {
    if (!(name in snapshot.attributes)) snapshot.attributes[name] = el.getAttribute(name);
    el.setAttribute(name, value);
  }
  for (const name of input.removeAttributes || []) {
    if (!(name in snapshot.attributes)) snapshot.attributes[name] = el.getAttribute(name);
    el.removeAttribute(name);
  }

  for (const c of input.addClasses || []) el.classList.add(c);
  for (const c of input.removeClasses || []) el.classList.remove(c);

  if (typeof input.textContent === 'string') {
    // Keep the original child nodes (not a copy) so undo restores them exactly.
    snapshot.childNodes = [...el.childNodes];
    el.textContent = input.textContent;
  }

  h.state().snapshots[actionId] = snapshot;
  return { selector: h.cssPath(el) };
}

/** Undo a modify_element using its snapshot. */
export function revertModify(h, selected, { actionId }) {
  const snapshot = h.state().snapshots[actionId];
  if (!snapshot) throw new Error('Nothing to undo (the page was probably reloaded)');
  const { el } = snapshot;
  if (!el.isConnected) throw new Error('The element is no longer in the page');

  const restore = (name, value) => (value === null ? el.removeAttribute(name) : el.setAttribute(name, value));
  for (const [name, value] of Object.entries(snapshot.attributes)) restore(name, value);
  restore('style', snapshot.style);
  restore('class', snapshot.className);
  if (snapshot.childNodes) el.replaceChildren(...snapshot.childNodes);

  delete h.state().snapshots[actionId];
  return true;
}

/** Draw a temporary outline around an element (hover on an action card). */
export function highlight(h, selected, { selector, ms = 1200 }) {
  let el;
  try { el = h.target(selector, selected); } catch { return false; }
  const r = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.setAttribute('data-integratedai-highlight', '');
  Object.assign(box.style, {
    position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    outline: '2px solid #1a73e8', background: 'rgba(26,115,232,0.15)', zIndex: '2147483647', pointerEvents: 'none',
    transition: 'opacity 300ms',
  });
  document.documentElement.appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; }, ms - 300);
  setTimeout(() => box.remove(), ms);
  return true;
}
