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

  /**
   * Short, unique-if-possible CSS selector for an element: its id, a stable attribute
   * (test id, name, aria-label, link target), or a path of tags/classes/positions that
   * is unique on the page. Inside a shadow root the selector is relative to that root;
   * use the element's ref (refOf) to target those.
   */
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    const root = el.getRootNode();
    const unique = (sel) => {
      try { return root.querySelectorAll(sel).length === 1; } catch { return false; }
    };
    if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    for (const attr of ['data-testid', 'data-test-id', 'data-qa', 'name', 'aria-label', 'href']) {
      const value = el.getAttribute(attr);
      if (!value || value.length > 120 || /[\n\r]/.test(value)) continue;
      const sel = `${el.localName}[${attr}="${value.replace(/["\\]/g, '\\$&')}"]`;
      if (unique(sel)) return sel;
    }

    const parts = [];
    let node = el;
    // Long enough to reach the row of a table or list, where rows of identical markup differ.
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 12) {
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

  /** Find the target element: by ref (from find_elements / page_outline), by selector, or the selected element ($0). */
  function target(selector, selected, ref) {
    if (ref) return byRef(ref);
    if (selector) {
      let el;
      try { el = document.querySelector(selector) || queryAll(selector)[0]; } catch { throw new Error(`Invalid selector: ${selector}`); }
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

  /**
   * A short reference to an element ("e12") that the AI can target in later calls. Unlike a
   * selector it always means exactly this element, also among rows of identical markup and
   * inside shadow roots. Refs stay valid until the page reloads (and the element is removed).
   */
  function refOf(el) {
    const s = state();
    s.refs = s.refs || { next: 0, byId: new Map(), ids: new WeakMap() };
    let id = s.refs.ids.get(el);
    if (!id) {
      id = `e${++s.refs.next}`;
      s.refs.ids.set(el, id);
      s.refs.byId.set(id, new WeakRef(el));
    }
    return id;
  }

  /** The element behind a ref; throws when it is gone, or was never given out (a guessed ref). */
  function byRef(id) {
    const refs = state().refs;
    if (!refs || !refs.byId.has(id)) {
      throw new Error(`${id} is not a ref from this page: use only refs that find_elements or page_outline returned, or a selector or the visible text`);
    }
    const el = refs.byId.get(id).deref();
    if (!el || !el.isConnected) throw new Error(`${id} is not on the page any more (the page changed or reloaded); look the element up again`);
    return el;
  }

  /** querySelectorAll that also looks inside open shadow roots (web components). */
  function queryAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) out.push(...queryAll(selector, host.shadowRoot));
    }
    return out;
  }

  /** Our own outline, badge, card and element picker are not part of the page. */
  const OWN_IDS = new Set(['integratedai-highlight', 'integratedai-working', 'integratedai-card', 'integratedai-picker']);
  const OWN_SELECTOR = [...OWN_IDS].map((id) => `#${id}`).join(', ');

  /** Is the element rendered with a size (it may still be scrolled out of view)? */
  function visible(el) {
    if (OWN_IDS.has(el.id) || el.closest(OWN_SELECTOR)) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  /** Is (part of) the element inside the visible area of the tab? */
  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  /**
   * What a person would call an element: its role and visible name, e.g. 'the "Search Wikipedia" field',
   * 'button "Send"', 'link "Pricing"' (the CSS-like label is for the AI, not for the questions we ask people).
   */
  function humanName(el) {
    if (!el || el === document.body || el === document.documentElement) return 'the page';
    const quote = (s) => `"${s.length > 60 ? `${s.slice(0, 60)}…` : s}"`;
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    const byId = labelledBy && labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
    const labelled = clean(el.getAttribute('aria-label') || byId || (el.labels && el.labels[0] && el.labels[0].innerText)
      || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'));
    if (el.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=""], [contenteditable="true"], [role=textbox], [role=searchbox], [role=combobox]')) {
      return labelled ? `the ${quote(labelled)} field` : el.matches('[type=search], [role=searchbox]') ? 'the search field' : 'a text field';
    }
    if (el.tagName === 'SELECT') return labelled ? `the ${quote(labelled)} menu` : 'a menu';
    if (el.matches('input[type=checkbox], [role=checkbox], [role=switch]')) return labelled ? `the ${quote(labelled)} checkbox` : 'a checkbox';
    if (el.matches('input[type=radio], [role=radio]')) return labelled ? `the ${quote(labelled)} option` : 'an option';
    const name = labelled || clean(el.innerText || el.value);
    const role = el.closest('a[href]') ? 'link' : el.closest('button, [role=button], input[type=submit], input[type=button], summary') ? 'button'
      : el.matches('[role=tab]') ? 'tab' : el.matches('[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]') ? 'menu item'
        : el.matches('li, [role=listitem], [role=option], [role=row], [role=treeitem], [role=gridcell]') ? 'item' : 'element';
    if (name) return `${role} ${quote(name)}`;
    // No name: its tag and id, but not class names (often generated, like "sc-651d33db-0 hygVWX").
    return `${role} (no label: ${el.localName}${el.id && !/\d{3}/.test(el.id) ? `#${el.id}` : ''})`;
  }

  /**
   * The readable text of an element, roughly as a person sees it: one line per block,
   * "#" before headings, "- " before list items, form fields with their values, and
   * hidden parts left out. Open shadow roots are included.
   * @param {Element} root
   * @param {{ links?: boolean, onScreenOnly?: boolean, max?: number }} opts
   *   links: add each link's address; onScreenOnly: only text in the visible area;
   *   max: stop after about this many characters.
   */
  function readable(root, { links = false, onScreenOnly = false, max = Infinity } = {}) {
    const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'head', 'meta', 'link']);
    const lines = [];
    let line = '';
    let lineIsPre = false;
    let size = 0;
    let visited = 0;
    const flush = () => {
      const text = lineIsPre ? line.replace(/\s+$/, '') : line.replace(/\s+/g, ' ').replace(/( \|)+\s*$/, '').trim();
      if (text.trim()) { lines.push(text); size += text.length + 1; }
      line = '';
      lineIsPre = false;
    };
    const field = (el) => {
      const name = humanName(el);
      if (el.matches('input[type=checkbox], input[type=radio]')) return `[${el.checked ? 'x' : ' '}] ${name}`;
      if (el.tagName === 'SELECT') return `[${name}: ${el.selectedOptions[0]?.text.trim() ?? ''}]`;
      if (el.matches('input[type=password]')) return `[${name}${el.value ? ': ••••' : ''}]`;
      if (el.matches('input[type=button], input[type=submit], input[type=reset]')) return `[button "${el.value}"]`;
      if (el.matches('input[type=hidden]')) return '';
      const value = String(el.value ?? '');
      return `[${name}${value ? `: ${value.length > 20000 ? `${value.slice(0, 20000)}…` : value}` : ''}]`;
    };
    /** Add text that keeps its own line breaks and indentation (a <pre>, a text area's value). */
    const addPre = (text) => {
      text.split('\n').forEach((part, i) => {
        if (i) { lineIsPre = true; flush(); }
        line += part;
        if (part) lineIsPre = true;
      });
    };
    /**
     * @param {Node} node
     * @param {boolean} pre inside white-space: pre*
     * @param {boolean} hidden inside visibility: hidden
     * @param {boolean} cell inside a table cell: blocks there don't start new lines (the row stays one line)
     */
    const walk = (node, pre, hidden, cell) => {
      if (size >= max || ++visited > 60000) return;
      if (node.nodeType === 3) {
        if (hidden) return;
        if (onScreenOnly) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const r = range.getBoundingClientRect();
          if (!(r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) return;
        }
        if (pre && !cell) addPre(node.textContent);
        else line += node.textContent;
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 11) { for (const child of node.childNodes) walk(child, pre, hidden, cell); return; }
      const el = node;
      if (SKIP.has(el.localName) || OWN_IDS.has(el.id)) return;
      if (el.localName === 'br') { if (cell) line += ' '; else flush(); return; }
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      // visibility is inherited but a child can be visible again, so walk on and skip hidden text.
      const isHidden = cs.visibility !== 'visible';
      if (el.localName === 'slot') { for (const child of el.assignedNodes({ flatten: true })) walk(child, pre, isHidden, cell); return; }
      // Table cells stay on their row's line, separated by " | ".
      const isCell = /^(td|th)$/.test(el.localName) || cs.display === 'table-cell';
      const block = !cell && !isCell && !cs.display.startsWith('inline') && cs.display !== 'contents';
      if (block) flush();
      else if (cell) line += ' ';
      if (el.matches('input, textarea, select')) {
        if (isHidden || (onScreenOnly && !onScreen(el))) return;
        if (el.localName === 'textarea' && /\n/.test(el.value) && !cell) {
          // A multi-line text area (a code viewer, a long message): its text on its own lines.
          flush();
          line = `[${humanName(el)}:]`;
          flush();
          addPre(el.value.length > 20000 ? `${el.value.slice(0, 20000)}…` : el.value);
          flush();
          return;
        }
        line += ` ${field(el)} `;
        if (block) flush();
        return;
      }
      if (/^h[1-6]$/.test(el.localName)) line += `${'#'.repeat(Number(el.localName[1]))} `;
      else if (el.localName === 'li') line += '- ';
      else if (el.localName === 'img' && el.alt && !isHidden && (!onScreenOnly || onScreen(el))) line += ` [image: ${el.alt}] `;
      const isPre = pre || /^pre/.test(cs.whiteSpace);
      for (const child of (el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes)) walk(child, isPre, isHidden, cell || isCell);
      if (links && el.localName === 'a' && el.href && !/^javascript:/i.test(el.href)) line += ` (${el.getAttribute('href').slice(0, 200)})`;
      if (isCell && !cell) line += ' | ';
      if (block) flush();
    };
    walk(root, false, false, false);
    flush();
    return lines.join('\n');
  }

  return {
    KEY_PROPERTIES, cssPath, label, computed, rect, overflowInfo, htmlExcerpt, toJson, target, state,
    refOf, byRef, queryAll, visible, onScreen, humanName, readable,
  };
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
  const el = h.target(input.selector, selected, input.ref);
  const include = new Set(input.include || []);
  const out = { ref: h.refOf(el), selector: h.cssPath(el), element: h.label(el), box: h.rect(el) };

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
    candidates = h.queryAll(selector).filter((el) => el !== document.body && el !== document.documentElement && el.localName !== 'head' && !el.closest('head'));
  } catch {
    throw new Error(`Invalid selector: ${selector}`);
  }

  if (input.text) {
    const needle = input.text.toLowerCase();
    // Match where the text actually lives: the element's own text nodes, or its value/label.
    const own = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')
      + ` ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.type === 'password' ? '' : el.value || ''} ${el.getAttribute('placeholder') || ''}`;
    candidates = candidates.filter((el) => own(el).toLowerCase().includes(needle));
  }
  const skip = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link']);
  candidates = candidates.filter((el) => !skip.has(el.localName) && !el.closest('#integratedai-highlight, #integratedai-working, #integratedai-card, #integratedai-picker'));
  // Visible matches first: those are the ones a person (and the interact steps) can use.
  const shown = candidates.filter((el) => h.visible(el));
  const ordered = [...shown, ...candidates.filter((el) => !shown.includes(el))];

  return {
    total: candidates.length,
    note: 'Target a match in interact steps by its ref; refs stay valid until the page reloads.',
    matches: ordered.slice(0, limit).map((el) => {
      const value = el.matches('input[type=password]') ? '' : el.value; // never read out passwords
      const text = (el.innerText || value || '').trim().replace(/\s+/g, ' ');
      return {
        ref: h.refOf(el),
        name: h.humanName(el),
        selector: h.cssPath(el),
        element: h.label(el),
        box: h.rect(el),
        visible: shown.includes(el),
        children: el.children.length,
        text: text.length > 80 ? `${text.slice(0, 80)}…` : text,
      };
    }),
  };
}

/**
 * read_text: the readable text of the page (or one element), in chunks the AI can page
 * through with `offset`. For reading articles, messages, search results, file contents.
 */
export function readText(h, selected, input) {
  const MAX = 12000;
  const root = input.ref || input.selector ? h.target(input.selector, selected, input.ref) : document.body;
  const from = Math.max(0, input.offset || 0);
  const all = h.readable(root, { links: input.links === true, max: from + MAX + 1 });
  const text = all.slice(from, from + MAX);
  const more = all.length > from + MAX;
  return {
    of: root === document.body ? 'the page' : `${h.humanName(root)} (${h.cssPath(root)})`,
    text: text || (from ? '(no more text)' : '(no visible text)'),
    ...(more ? { more: true, nextOffset: from + MAX, note: 'Call read_text again with nextOffset for the rest.' } : {}),
  };
}

/**
 * page_outline (and the page report after each agent step): what's on screen, the way a
 * person scanning the page sees it. Buttons, links and fields with refs to target them, the
 * focused element, an open dialog, headings, frames, and the visible text (short).
 * @param {{ all?: boolean, limit?: number, textChars?: number }} input
 *   all: the whole page instead of only what's on screen
 */
export function pageOutline(h, selected, input = {}) {
  const limit = Math.min(Math.max(input.limit || 60, 1), 200);
  const textChars = input.textChars ?? 1500;
  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=""], [contenteditable="true"], '
    + '[role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=checkbox], '
    + '[role=radio], [role=switch], [role=textbox], [role=searchbox], [role=combobox], [role=treeitem], [role=slider]';
  const CLICKABLE = 'a[href], button, [role=button], [role=link]';
  const where = (el) => input.all || h.onScreen(el);

  // An open dialog takes over the page: outline only that.
  // (Only modal ones: some sites keep a non-modal role=dialog, like a chat widget, open all the time.)
  const dialogs = h.queryAll('dialog:modal, [aria-modal=true], [role=alertdialog]').filter((d) => h.visible(d) && h.onScreen(d));
  const scope = dialogs.length ? dialogs[dialogs.length - 1] : document.body;

  const shown = h.queryAll(INTERACTIVE, scope).filter((el) => h.visible(el) && where(el)
    // Not the parts of a link or button that is listed itself (an icon span with tabindex, …).
    && !(el.parentElement && el.parentElement.closest(CLICKABLE) && !el.matches('input, select, textarea')));
  // The page's main content first (in page order), then the rest (header menus, footers): with a limit,
  // the content is what should make it into the list.
  const main = scope === document.body ? h.queryAll('main, [role=main]').find((m) => h.visible(m)) : null;
  const found = main ? [...shown.filter((el) => main.contains(el)), ...shown.filter((el) => !main.contains(el))] : shown;
  const describe = (el) => {
    const bits = [`${h.refOf(el)} ${h.humanName(el)}`];
    if (el.matches('input[type=checkbox], input[type=radio]')) bits.push(el.checked ? '(ticked)' : '(not ticked)');
    else if (el.getAttribute('aria-checked')) bits.push(el.getAttribute('aria-checked') === 'true' ? '(ticked)' : '(not ticked)');
    else if (el.tagName === 'SELECT') bits.push(`= "${el.selectedOptions[0]?.text.trim() ?? ''}"`);
    else if (el.matches('input:not([type=password]), textarea') && el.value) bits.push(`= "${el.value.length > 60 ? `${el.value.slice(0, 60)}…` : el.value}"`);
    else if (el.isContentEditable && el.innerText.trim()) bits.push(`= "${el.innerText.trim().slice(0, 60)}"`);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('(disabled)');
    if (el.getAttribute('aria-expanded')) bits.push(el.getAttribute('aria-expanded') === 'true' ? '(open)' : '(closed)');
    if (el.getAttribute('aria-selected') === 'true' || (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false')) bits.push('(current)');
    if (el.localName === 'a' && el.href && !/^javascript:/i.test(el.href)) {
      let to = el.href;
      try {
        const u = new URL(el.href);
        // Where it goes, not its tracking: a long query string is cut (the ref still clicks the real link).
        const query = u.search.length > 40 ? '?…' : u.search;
        to = `${u.origin === location.origin ? '' : u.origin}${u.pathname}${query}${u.hash.length > 30 ? '' : u.hash}`;
      } catch { /* keep as is */ }
      bits.push(`→ ${to.length > 80 ? `${to.slice(0, 80)}…` : to}`);
      if (el.target === '_blank') bits.push('(opens a new tab)');
    }
    return bits.join(' ');
  };

  const focused = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const headings = h.queryAll('h1, h2, h3, [role=heading]', scope).filter((el) => h.visible(el) && where(el))
    .slice(0, 12).map((el) => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 100)).filter(Boolean);
  const frames = [...document.querySelectorAll('iframe, frame')].filter((f) => h.visible(f)).slice(0, 10).map((f) => {
    let url = f.src;
    try { url = f.contentWindow.location.href; } catch { /* cross-origin: its src is the best we know */ }
    return { url, title: f.title || undefined, onScreen: h.onScreen(f) };
  }).filter((f) => /^https?:/.test(f.url));

  const page = document.scrollingElement || document.documentElement;
  const text = textChars > 0 ? h.readable(scope, { onScreenOnly: !input.all, max: textChars + 1 }) : '';
  return {
    url: location.href,
    title: document.title,
    scroll: page.scrollHeight > innerHeight + 4
      ? `screen ${Math.floor(scrollY / innerHeight) + 1} of ${Math.ceil(page.scrollHeight / innerHeight)}`
      : 'the whole page fits on screen',
    ...(dialogs.length ? { dialog: `${h.humanName(scope)} is open; only its contents are listed` } : {}),
    ...(focused ? { focused: `${h.refOf(focused)} ${h.humanName(focused)}` } : {}),
    ...(headings.length ? { headings } : {}),
    elements: found.slice(0, limit).map(describe),
    ...(found.length > limit ? { more: `${found.length - limit} more; use find_elements to search them` } : {}),
    ...(frames.length ? { frames } : {}),
    ...(text ? { text: text.length > textChars ? `${text.slice(0, textChars)}… (read_text for all of it)` : text } : {}),
  };
}

/**
 * translate_page, step 1: the page's visible text, as numbered pieces (one per text node), to translate in
 * batches. The nodes are kept in the hidden state (translate.nodes) for applyTranslations. Skips code,
 * form fields, hidden text and our own UI. Leading/trailing spaces stay out of the pieces (and are kept).
 * @returns {{ pieces: { id: number, text: string }[], cut: boolean }}  cut: the page had more than the limit
 */
export function collectTexts(h, selected, { maxPieces = 600, maxChars = 40000 } = {}) {
  const state = h.state();
  state.translate = state.translate ?? { nodes: [], originals: new Map() };
  const nodes = [];
  const pieces = [];
  let chars = 0;
  let cut = false;
  const SKIP = 'script, style, noscript, template, code, pre, kbd, samp, textarea, input, select, svg, math, [contenteditable=""], [contenteditable="true"], #integratedai-card, #integratedai-working, #integratedai-highlight';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.textContent.trim();
      if (text.length < 2 || !/\p{L}/u.test(text)) return NodeFilter.FILTER_REJECT; // no letters: numbers, symbols
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP) || !h.visible(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (pieces.length >= maxPieces || chars + text.length > maxChars) { cut = true; break; }
    nodes.push(node);
    pieces.push({ id: nodes.length - 1, text });
    chars += text.length;
  }
  state.translate.nodes = nodes;
  return { pieces, cut };
}

/**
 * translate_page, step 2: put translated pieces in place of the originals (kept for undoTranslation).
 * @param {{ items: { id: number, text: string }[] }} args
 */
export function applyTranslations(h, selected, { items }) {
  const t = h.state().translate;
  if (!t?.nodes.length) throw new Error('The page changed since its text was read: translate it again');
  let done = 0;
  for (const { id, text } of items) {
    const node = t.nodes[id];
    if (!node || !node.isConnected || typeof text !== 'string') continue;
    if (!t.originals.has(node)) t.originals.set(node, node.textContent);
    const original = t.originals.get(node);
    // Keep the spaces around the text: they separate it from its neighbours.
    node.textContent = `${original.match(/^\s*/)[0]}${text}${original.match(/\s*$/)[0]}`;
    done++;
  }
  return done;
}

/** Undo translate_page: every translated text back to its original. */
export function undoTranslation(h) {
  const t = h.state().translate;
  if (!t?.originals.size) throw new Error('Nothing to undo (the page was probably reloaded)');
  for (const [node, original] of t.originals) if (node.isConnected) node.textContent = original;
  t.originals.clear();
  return true;
}

/** Empty the console buffer filled by content/console-capture.js (the Console tab's Clear). */
export function clearConsole() {
  window[Symbol.for('integratedai.console')]?.clear();
  return true;
}

/**
 * The card's "Pick element" (it has no Elements panel): outline the element under the mouse, and on
 * a click make it the selected element (kept in the hidden state; callInPage passes it as $0) and tell
 * the card. Esc, or a second call with stop: true, cancels. Runs in the extension's isolated world.
 */
export function pickElement(h, selected, { stop = false } = {}) {
  const state = h.state();
  state.stopPicker?.();
  if (stop) return false;
  const box = document.createElement('div');
  box.id = 'integratedai-picker';
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #1a73e8;'
    + 'background:rgba(26,115,232,.12);border-radius:2px;display:none';
  const tag = document.createElement('div');
  tag.style.cssText = 'position:absolute;left:-2px;top:-22px;background:#1a73e8;color:#fff;font:12px/1.6 system-ui,sans-serif;'
    + 'padding:0 6px;border-radius:2px;white-space:nowrap';
  box.append(tag);
  document.documentElement.append(box);
  let current = null;
  const ours = (el) => !el || el === box || el.id === 'integratedai-card' || el === document.documentElement;
  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (ours(el)) { box.style.display = 'none'; current = null; return; }
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    tag.textContent = h.label(el);
    tag.style.top = r.top < 24 ? `${r.height + 4}px` : '-22px';
  };
  const done = (el) => {
    state.stopPicker();
    if (el) state.picked = el;
    globalThis.chrome?.runtime?.sendMessage({ type: 'card.picked', picked: Boolean(el) }).catch?.(() => {});
  };
  // Capture phase, and swallowed: picking must not click the page's links and buttons.
  const swallow = (e) => {
    if (ours(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'click') done(current);
  };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  addEventListener('mousemove', move, true);
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) addEventListener(type, swallow, true);
  addEventListener('keydown', key, true);
  state.stopPicker = () => {
    removeEventListener('mousemove', move, true);
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) removeEventListener(type, swallow, true);
    removeEventListener('keydown', key, true);
    box.remove();
    state.stopPicker = undefined;
  };
  return true;
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
  if (input.fullViewport || (!input.ref && !input.selector && !(selected instanceof Element))) {
    return { viewport, scroll, scrolled: false, rect: null, label: 'the visible page' };
  }
  const el = h.target(input.selector, selected, input.ref);
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

/**
 * screenshot: hide the card on the page (if it's open) for the moment of the capture, so it isn't
 * in the picture, and show it again afterwards.
 */
export function setCardHidden(h, selected, { hidden }) {
  const card = document.getElementById('integratedai-card');
  if (card) card.style.visibility = hidden ? 'hidden' : '';
  return Boolean(card);
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
export function highlight(h, selected, { selector, ref, ms = 1200 }) {
  let el;
  try { el = h.target(selector, selected, ref); } catch { return false; }
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
