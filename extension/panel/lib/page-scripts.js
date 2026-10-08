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

/**
 * Helpers available to every page function as `h`.
 *
 * `scope` is the page access the user chose, sent by the panel with every call (so the page can't change it):
 *   { area: [{x, y}, …], url, anchor }  only what lies inside this polygon exists for the AI. Its coordinates
 *                          are in the content of `anchor` (a selector: the panel that scrolls around it, so the
 *                          area moves with the content), or of the page when there's no anchor:
 *                          the element lookups and the readable text below leave everything else out, and
 *                          anything named outside it is refused. When in doubt (partly inside, no size), it's left
 *                          out. url: the page it was marked on; on any other page (the AI went elsewhere) nothing
 *                          is shown at all until the user confirms the area there.
 */
export function pageHelpers(scope = null) {
  const MAX_HTML = 1500;
  const AREA = scope && Array.isArray(scope.area) && scope.area.length >= 3 ? scope.area : null;
  let anchorEl = null;
  if (AREA && typeof scope.anchor === 'string' && scope.anchor) {
    try { anchorEl = document.querySelector(scope.anchor); } catch { /* not a selector */ }
  }
  // Another page, or its scrolling panel is gone: nothing is shown until the user confirms the area again.
  // (site: "keep on this site", checked by origin; url: this page only. A frame's scope has neither: the page
  // around it was checked when the frame's part of the area was worked out, see areaInFrame.)
  const WRONG_PAGE = Boolean(AREA && ((scope.url && location.href.split('#')[0] !== scope.url)
    || (scope.site && location.origin !== scope.site) || (scope.anchor && !anchorEl)));
  // In a frame: the points are on the frame's screen (its viewport), and only what the frame shows counts.
  const IN_FRAME = Boolean(AREA && scope.frame);

  /** Where the area's coordinates start, on screen: the top-left of the content it is attached to. */
  function areaOrigin() {
    if (IN_FRAME) return { x: 0, y: 0 };
    if (!anchorEl) return { x: -scrollX, y: -scrollY };
    const r = anchorEl.getBoundingClientRect();
    return { x: r.left + anchorEl.clientLeft - anchorEl.scrollLeft, y: r.top + anchorEl.clientTop - anchorEl.scrollTop };
  }
  const WRONG_PAGE_TEXT = 'This is a different page from the one the user marked the area on: nothing here can be shown until the user confirms the area on this page. Tell the user, and wait for their next message.';

  /** With an area: stop right away on a page it wasn't marked on. */
  function assertPage() {
    if (WRONG_PAGE) throw new Error(WRONG_PAGE_TEXT);
  }

  /** Is the point (document coordinates) inside the marked polygon? Ray casting. */
  function pointInArea(x, y) {
    let inside = false;
    for (let i = 0, j = AREA.length - 1; i < AREA.length; j = i++) {
      const a = AREA[i];
      const b = AREA[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  /**
   * A frame's document when it's from the same site (a player written into an empty frame, a course frame):
   * then its content is part of the page for the tools, like a shadow root. Null for other sites' frames (those
   * are used with the "frame" option).
   */
  function frameDoc(frame) {
    try {
      const doc = frame.contentDocument;
      return doc && doc.body ? doc : null;
    } catch {
      return null;
    }
  }

  /**
   * A box from getBoundingClientRect in an element's own document, on the page's screen: moved by where each
   * frame around it shows its content. clipped: part of it is scrolled out of view inside a frame.
   */
  function toPage(r, doc) {
    let { left, top, right, bottom } = r;
    let clipped = false;
    for (let win = doc.defaultView; win && win !== window; win = win.parent) {
      const fe = win.frameElement;
      if (!fe) break;
      if (left < -1 || top < -1 || right > fe.clientWidth + 1 || bottom > fe.clientHeight + 1) clipped = true;
      const fr = fe.getBoundingClientRect();
      const cs = getComputedStyle(fe);
      const dx = fr.left + fe.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      const dy = fr.top + fe.clientTop + (parseFloat(cs.paddingTop) || 0);
      left += dx; right += dx; top += dy; bottom += dy;
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, clipped };
  }

  /** The element's box on the page's screen (see toPage). */
  function pageRect(el) {
    return toPage(el.getBoundingClientRect(), el.ownerDocument);
  }

  /** What has the keyboard: inside a same-site frame, the element there. */
  function activeElement() {
    let el = document.activeElement;
    for (let doc = el && (el.localName === 'iframe' || el.localName === 'frame') ? frameDoc(el) : null; doc; ) {
      el = doc.activeElement;
      doc = el && (el.localName === 'iframe' || el.localName === 'frame') ? frameDoc(el) : null;
    }
    return el;
  }

  /** Does the segment a–b pass through the open box (Liang–Barsky clipping)? */
  function segmentCrossesBox(a, b, left, top, right, bottom) {
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (const [p, q] of [[-dx, a.x - left], [dx, right - a.x], [-dy, a.y - top], [dy, bottom - a.y]]) {
      if (p === 0) { if (q <= 0) return false; continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return t0 < t1;
  }

  /**
   * Is this box (viewport coordinates, from getBoundingClientRect) completely inside the area? Exactly: all its
   * corners are inside and no side of the area passes through it (so a corner of the area can't poke into it).
   * One pixel in from its edges, so a border lying exactly on the line still counts as inside.
   */
  function rectInArea(r) {
    if (WRONG_PAGE || (!r.width && !r.height)) return false;
    // In a frame, what is scrolled out of its view isn't on the user's screen: outside.
    if (IN_FRAME && (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)) return false;
    const o = areaOrigin();
    const left = r.left - o.x + 1;
    const top = r.top - o.y + 1;
    const right = Math.max(left, r.right - o.x - 1);
    const bottom = Math.max(top, r.bottom - o.y - 1);
    if (![[left, top], [right, top], [left, bottom], [right, bottom]].every(([x, y]) => pointInArea(x, y))) return false;
    for (let i = 0, j = AREA.length - 1; i < AREA.length; j = i++) {
      if (segmentCrossesBox(AREA[j], AREA[i], left, top, right, bottom)) return false;
    }
    return true;
  }

  /** Does the box (viewport coordinates) overlap the area at all? */
  function rectTouchesArea(r) {
    if (!AREA || WRONG_PAGE || !r.width || !r.height) return Boolean(!AREA);
    const o = areaOrigin();
    const left = r.left - o.x;
    const top = r.top - o.y;
    const right = r.right - o.x;
    const bottom = r.bottom - o.y;
    if ([[left, top], [right, top], [left, bottom], [right, bottom]].some(([x, y]) => pointInArea(x, y))) return true;
    if (AREA.some((p) => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom)) return true;
    for (let i = 0, j = AREA.length - 1; i < AREA.length; j = i++) {
      if (segmentCrossesBox(AREA[j], AREA[i], left, top, right, bottom)) return true;
    }
    return false;
  }

  /** Without an area: everything. With one: only elements whose whole box is inside it. */
  function inArea(el) {
    if (!AREA) return true;
    if (!el || el.nodeType !== 1) return false; // (an element from a frame isn't an instanceof this window's Element)
    const r = pageRect(el);
    return !r.clipped && rectInArea(r);
  }

  /** Throw when the user's area leaves this element out (the AI asked for something it can't see). */
  function checkArea(el) {
    assertPage();
    if (!inArea(el)) throw new Error('That element is outside the area the user marked; only what is inside it can be used');
    return el;
  }

  /** Is all of this text node inside the area? */
  function textInArea(node) {
    if (!AREA) return true;
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width && r.height).map((r) => toPage(r, node.ownerDocument));
    return rects.length > 0 && rects.every((r) => !r.clipped && rectInArea(r));
  }

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
    if (!el || el.nodeType !== 1) return ''; // (also elements in a frame, from another window)
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
    if (!el || el.nodeType !== 1) return ''; // (also elements in a frame, from another window)
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

  /** Query parameters that carry secrets (as in inspections.js). */
  const SECRET_PARAM = /([?&](?:token|access_token|id_token|refresh_token|code|key|api_key|apikey|secret|password|sig|signature|session|csrf|auth)[^=&#]*=)[^&#]*/gi;
  /** One long run of letters and digits: an id, a token, a key. */
  const TOKEN_LIKE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-.=+/]{32,}$/;

  /**
   * A copy of the element that is safe to show the AI: values of hidden, password, one-time-code and card
   * fields, script contents, token-like attribute values and secret URL parameters are taken out; with an
   * area, so is everything inside it that lies outside the area or isn't shown.
   */
  function safeCopy(el) {
    const copy = el.cloneNode(true);
    if (AREA) {
      const originals = [...el.querySelectorAll('*')];
      const copies = [...copy.querySelectorAll('*')];
      originals.forEach((o, i) => {
        if (!copy.contains(copies[i])) return; // already cut out with an ancestor
        if (!o.getClientRects().length || !inArea(o)) copies[i].replaceWith(document.createComment(' left out (not shown, or outside the marked area) '));
      });
    }
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      if (node.localName === 'script') { node.textContent = '…'; continue; }
      const secretField = node.matches('input[type=hidden], input[type=password], [autocomplete~="one-time-code"], [autocomplete*="cc-"], [autocomplete*="password"]');
      for (const attr of [...node.attributes]) {
        if (attr.name === 'value' && secretField) node.setAttribute('value', '[hidden]');
        else if (TOKEN_LIKE.test(attr.value)) node.setAttribute(attr.name, '[token]');
        else if (/^(href|src|action|srcset|data-[\w-]*url[\w-]*)$/i.test(attr.name) && SECRET_PARAM.test(attr.value)) {
          node.setAttribute(attr.name, attr.value.replace(SECRET_PARAM, '$1redacted'));
        }
        SECRET_PARAM.lastIndex = 0;
      }
    }
    return copy;
  }

  /** outerHTML (of a safe copy), shortened: long text cut, deep children replaced by "…". */
  function htmlExcerpt(el, max = MAX_HTML) {
    el = safeCopy(el);
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
      if (value && value.nodeType === 1) return { element: cssPath(value) };
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
      try { el = AREA ? queryAll(selector)[0] : document.querySelector(selector) || queryAll(selector)[0]; } catch { throw new Error(`Invalid selector: ${selector}`); }
      if (!el) throw new Error(AREA ? `No element inside the marked area matches ${selector}` : `No element matches ${selector}`);
      return el;
    }
    if (!(selected && selected.nodeType === 1)) throw new Error('No element is selected in the Elements panel');
    return checkArea(selected);
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
    return checkArea(el);
  }

  /** querySelectorAll that also looks inside open shadow roots (web components); with an area, only what's inside it. */
  function queryAll(selector, root = document) {
    const all = (r) => {
      const out = [...r.querySelectorAll(selector)];
      for (const host of r.querySelectorAll('*')) {
        if (host.shadowRoot) out.push(...all(host.shadowRoot));
        if (host.localName === 'iframe' || host.localName === 'frame') {
          const doc = frameDoc(host);
          if (doc) out.push(...all(doc));
        }
      }
      return out;
    };
    const found = all(root);
    return AREA ? found.filter(inArea) : found;
  }

  /** queryAll without the area filter: only to tell the AI what the area's edge cuts (pageOutline's partlyInside). */
  function queryAllUnlimited(selector) {
    const all = (r) => {
      const out = [...r.querySelectorAll(selector)];
      for (const host of r.querySelectorAll('*')) {
        if (host.shadowRoot) out.push(...all(host.shadowRoot));
        if (host.localName === 'iframe' || host.localName === 'frame') {
          const doc = frameDoc(host);
          if (doc) out.push(...all(doc));
        }
      }
      return out;
    };
    return all(document);
  }

  /** Our own outline, badge, card and element picker are not part of the page. */
  const OWN_IDS = new Set(['integratedai-highlight', 'integratedai-working', 'integratedai-card', 'integratedai-picker', 'integratedai-area']);
  const OWN_SELECTOR = [...OWN_IDS].map((id) => `#${id}`).join(', ');

  /** Is the element rendered with a size (it may still be scrolled out of view), and inside the area if there is one? */
  function visible(el) {
    if (OWN_IDS.has(el.id) || el.closest(OWN_SELECTOR)) return false;
    const r = pageRect(el);
    if (!r.width || !r.height) return false;
    if (AREA && (r.clipped || !rectInArea(r))) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  /** Is (part of) the element inside the visible area of the tab? */
  function onScreen(el) {
    const r = pageRect(el);
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
    // (Label elements elsewhere on the page count only when they're inside the area too.)
    const shownLabel = (node) => (node && inArea(node) ? node.innerText || '' : '');
    const byId = labelledBy && labelledBy.split(/\s+/).map((id) => shownLabel(document.getElementById(id))).join(' ');
    const labelled = clean(el.getAttribute('aria-label') || byId || (el.labels && shownLabel(el.labels[0]))
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
    const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'head', 'meta', 'link']);
    const lines = [];
    let line = '';
    let lineIsPre = false;
    let size = 0;
    let visited = 0;
    const flush = () => {
      const text = lineIsPre ? line.replace(/\s+$/, '') : line.replace(/\s+/g, ' ').replace(/( \|)+\s*$/, '').trim();
      // (A heading or list mark with no text: nothing to read, e.g. its text is outside the marked area.)
      if (text.trim() && !/^(#{1,6}|-||)$/.test(text.trim())) { lines.push(text); size += text.length + 1; }
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
        if (AREA && node.textContent.trim() && !textInArea(node)) return;
        if (onScreenOnly) {
          const range = node.ownerDocument.createRange();
          range.selectNodeContents(node);
          const r = toPage(range.getBoundingClientRect(), node.ownerDocument);
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
      if (el.localName === 'iframe' || el.localName === 'frame') {
        // A same-site frame's text is read with the page (another site's frame: read it with the "frame" option).
        const doc = frameDoc(el);
        if (doc) { flush(); walk(doc.body, false, false, false); flush(); }
        return;
      }
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
        if (isHidden || (onScreenOnly && !onScreen(el)) || !inArea(el)) return;
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
      else if (el.localName === 'img' && el.alt && !isHidden && (!onScreenOnly || onScreen(el)) && inArea(el)) line += ` [image: ${el.alt}] `;
      const isPre = pre || /^pre/.test(cs.whiteSpace);
      for (const child of (el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes)) walk(child, isPre, isHidden, cell || isCell);
      if (links && el.localName === 'a' && el.href && !/^javascript:/i.test(el.href) && inArea(el)) line += ` (${el.getAttribute('href').slice(0, 200)})`;
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
    queryAllUnlimited, area: AREA, anchor: anchorEl, wrongPage: WRONG_PAGE, areaOrigin, rectTouchesArea, inArea, pageRect, frameDoc, activeElement, checkArea, textInArea, assertPage, pointInArea: (x, y) => (AREA ? pointInArea(x, y) : true),
  };
}

// ───────────────────────────────────────────────────────────── context

/** Basic facts about the page. */
export function pageInfo() {
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || '',
    timeOrigin: performance.timeOrigin, // changes on every page load; used to expire undo info
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
  };
}

/** One-line label of the selected element (for the "$0" chip). */
export function selectedLabel(h, selected) {
  if (!(selected && selected.nodeType === 1)) return null;
  return { label: h.label(selected), selector: h.cssPath(selected) };
}

/** The visible text of the selected element ($0), for "Copy text"; null if nothing is selected. */
export function selectedText(h, selected) {
  if (!(selected && selected.nodeType === 1)) return null;
  return (selected.innerText ?? selected.textContent ?? '').trim();
}

/** The small default context for the selected element ($0). */
export function describeSelected(h, selected) {
  if (!(selected && selected.nodeType === 1)) return null;
  if (!h.inArea(selected)) return h.area ? 'The selected element is outside the area the user marked (or this is another page), so it is not shared' : null;
  const el = selected;
  const parent = el.parentElement && h.inArea(el.parentElement) ? el.parentElement : null;
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
    for (let node = el.parentElement; node && h.inArea(node) && out.ancestors.length < 8; node = node.parentElement) {
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
    out.children = [...el.children].filter((c) => h.inArea(c)).slice(0, 30).map((c) => ({
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
  h.assertPage();
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
  h.assertPage();
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
  h.assertPage();
  const limit = Math.min(Math.max(input.limit || 60, 1), 200);
  const textChars = input.textChars ?? 1500;
  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=""], [contenteditable="true"], '
    + '[role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=checkbox], '
    + '[role=radio], [role=switch], [role=textbox], [role=searchbox], [role=combobox], [role=treeitem], [role=slider]';
  const CLICKABLE = 'a[href], button, [role=button], [role=link]';
  // (With an area: all of it, on screen or not; it moves with the content, so scrolling shows nothing more.)
  const where = (el) => input.all || h.area || h.onScreen(el);

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

  const active = h.activeElement();
  const focused = active && active !== document.body && active.localName !== 'body' && h.inArea(active) ? active : null;
  const headings = h.queryAll('h1, h2, h3, [role=heading]', scope).filter((el) => h.visible(el) && where(el))
    .slice(0, 12).map((el) => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 100)).filter(Boolean);
  // (With an area: the frames it reaches into, which the tools can then work in, limited to the area there too.)
  const frames = [...document.querySelectorAll('iframe, frame')].filter((f) => (h.area ? h.rectTouchesArea(f.getBoundingClientRect()) : h.visible(f))).slice(0, 10).map((f) => {
    let url = f.src;
    try { url = f.contentWindow.location.href; } catch { /* cross-origin: its src is the best we know */ }
    return { url, title: f.title || undefined, onScreen: h.onScreen(f) };
  }).filter((f) => /^https?:/.test(f.url));

  const page = document.scrollingElement || document.documentElement;
  const text = textChars > 0 ? h.readable(scope, { onScreenOnly: !input.all && !h.area, max: textChars + 1 }) : '';
  return {
    // With an area, the page's address and title stay out (a title can hold exactly what the user keeps hidden).
    ...(h.area ? { area: 'Only the area the user marked is shown; the rest of the page is hidden from you.' } : { url: location.href, title: document.title }),
    scroll: page.scrollHeight > innerHeight + 4
      ? `screen ${Math.floor(scrollY / innerHeight) + 1} of ${Math.ceil(page.scrollHeight / innerHeight)}`
      : 'the whole page fits on screen',
    ...(dialogs.length ? { dialog: `${h.humanName(scope)} is open; only its contents are listed` } : {}),
    ...(focused ? { focused: `${h.refOf(focused)} ${h.humanName(focused)}` } : {}),
    ...(headings.length ? { headings } : {}),
    elements: found.slice(0, limit).map(describe),
    // With an area: buttons, links and fields that the area's edge cuts through (left out, so the AI can say so).
    ...(() => {
      if (!h.area) return {};
      const cut = h.queryAllUnlimited?.(INTERACTIVE).filter((el) => !h.inArea(el) && h.rectTouchesArea(h.pageRect(el))) ?? [];
      return cut.length
        ? { partlyInside: `${cut.length} more (${cut.slice(0, 5).map((el) => h.humanName(el)).join(', ')}) are cut by the edge of the marked area and are left out; if one is needed, ask the user to mark a slightly bigger area` }
        : {};
    })(),
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
  h.assertPage();
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
      if (!parent || parent.closest(SKIP) || !h.visible(parent) || !h.textInArea(node)) return NodeFilter.FILTER_REJECT;
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
  h.assertPage();
  const viewport = { width: innerWidth, height: innerHeight };
  const scroll = { x: scrollX, y: scrollY };
  if (h.area) {
    // The area, whatever was asked: brought into view (its scrolling panel first, then the page), and its outline
    // on screen so the panel can grey out everything outside it before the picture goes anywhere.
    const onScreen = () => {
      const o = h.areaOrigin();
      const polygon = h.area.map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
      const xs = polygon.map((p) => p.x);
      const ys = polygon.map((p) => p.y);
      return { polygon, box: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) } };
    };
    let { polygon, box } = onScreen();
    let scrolled = false;
    const outside = (b, r) => b.top < r.top || b.bottom > r.bottom || b.left < r.left || b.right > r.right;
    if (h.anchor) {
      const r = h.anchor.getBoundingClientRect();
      if (outside(box, r)) {
        h.anchor.scrollBy({ left: box.left - r.left - 16, top: box.top - r.top - 16, behavior: 'instant' });
        ({ polygon, box } = onScreen());
      }
    }
    if (outside(box, { top: 0, left: 0, right: innerWidth, bottom: innerHeight })) {
      scrollBy({ left: box.left - 16, top: box.top - 16, behavior: 'instant' });
      scrolled = true;
      ({ polygon, box } = onScreen());
    }
    return {
      viewport, scroll, scrolled, polygon,
      rect: { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top },
      label: 'the marked area',
    };
  }
  if (input.fullViewport || (!input.ref && !input.selector && !(selected && selected.nodeType === 1))) {
    return { viewport, scroll, scrolled: false, rect: null, label: 'the visible page' };
  }
  const el = h.target(input.selector, selected, input.ref);
  let r = h.pageRect(el);
  if (!r.width || !r.height) throw new Error(`${h.cssPath(el)} has no visible size (hidden or empty)`);
  let scrolled = false;
  if (r.bottom <= 0 || r.top >= viewport.height || r.right <= 0 || r.left >= viewport.width) {
    el.scrollIntoView({ block: r.height > viewport.height ? 'start' : 'center', inline: 'nearest' });
    scrolled = true;
    r = h.pageRect(el);
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
  // The area's outline isn't part of the page either.
  const area = document.getElementById('integratedai-area');
  if (area) area.style.visibility = hidden ? 'hidden' : '';
  return Boolean(card || area); // something to wait for (a repaint)
}

// ───────────────────────────────────────────────────────────── the marked area

/**
 * The area the AI may see, on the page:
 *   mode "edit": the user marks it. Drag to draw a rectangle, or click an element to take its box. Then drag
 *                the corners, drag the dots between corners to add a corner, drag inside to move it, and
 *                double-click a corner to remove it. Done (Enter), Redraw, Cancel (Esc).
 *   mode "show": just its outline (not clickable), so the user always sees what's shared.
 *   mode "off":  nothing.
 * Points are in document coordinates. The panel reads the result with areaStatus (and keeps the area itself:
 * it sends it with every call, so what the page does with this outline can't widen it).
 * @param {{ mode: 'edit' | 'show' | 'off', points?: {x: number, y: number}[], labels?: Record<string, string> }} args
 */
export function areaOverlay(h, selected, { mode, points = [], anchor = '', labels = {} }) {
  const state = h.state();
  state.areaUi?.stop();
  state.areaResult = null;
  if (mode === 'off') return true;
  const L = { draw: 'Drag to mark the area the AI may see, or click an element', edit: 'Drag the corners to shape it. Drag a dot between corners to add one, drag inside to move it, double-click a corner to remove it.',
    done: 'Done', redraw: 'Redraw', cancel: 'Cancel', undo: 'Undo', redo: 'Redo', shown: 'The AI sees only this', ...labels };
  const BLUE = '#1a73e8';
  const editing = mode === 'edit';
  let pts = points.map((p) => ({ x: p.x, y: p.y }));
  let phase = editing && pts.length < 3 ? 'draw' : 'edit';
  // The panel that scrolls around the area (null: the page). Points are in its content's coordinates, so the area
  // moves with the content (apps like Gmail or Blackboard scroll a panel, not the page).
  let anchorEl = null;
  if (anchor) { try { anchorEl = document.querySelector(anchor); } catch { /* gone */ } }

  const host = document.createElement('div');
  host.id = 'integratedai-area';
  // touch-action: none, so a finger drag shapes the area instead of scrolling the page.
  host.style.cssText = `all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:${editing ? 'auto' : 'none'};touch-action:none`;
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    svg { position: fixed; inset: 0; width: 100vw; height: 100vh; overflow: visible; }
    .dim { fill: rgba(32, 33, 36, ${editing ? 0.5 : 0}); fill-rule: evenodd; }
    .halo { fill: none; stroke: #fff; stroke-width: ${editing ? 7 : 4}; stroke-linejoin: round; opacity: .9; }
    .shape { fill: transparent; stroke: ${BLUE}; stroke-width: ${editing ? 3.5 : 2}; stroke-linejoin: round; }
    .rubber { fill: rgba(26, 115, 232, .12); stroke: ${BLUE}; stroke-width: 1.5; stroke-dasharray: 4 3; }
    .corner { fill: #fff; stroke: ${BLUE}; stroke-width: 2; cursor: grab; }
    .corner.active { fill: ${BLUE}; }
    .mid { fill: ${BLUE}; opacity: .55; cursor: copy; }
    .mid:hover { opacity: 1; }
    .bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
      max-width: calc(100vw - 32px); padding: 6px 8px 6px 12px; border-radius: 6px; background: #202124; color: #e8eaed;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
    .bar span { flex: 1; min-width: 0; }
    .bar button { font: inherit; padding: 3px 10px; border-radius: 4px; border: 1px solid #5f6368; background: #303134; color: #e8eaed; cursor: pointer; }
    .bar button.primary { background: ${BLUE}; border-color: ${BLUE}; color: #fff; }
    .bar button:disabled { opacity: .5; cursor: default; }
    .tag { position: fixed; padding: 2px 10px; border-radius: 4px; background: ${BLUE}; color: #fff; white-space: nowrap;
      font: 600 13px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 0 0 2px #fff; }
    .pick { position: fixed; border: 2px solid ${BLUE}; background: rgba(26, 115, 232, .1); border-radius: 2px; pointer-events: none; display: none; }
  </style>
  <svg xmlns="http://www.w3.org/2000/svg"></svg>
  <div class="pick"></div>
  ${editing ? `<div class="bar" role="toolbar"><span></span><button type="button" data-do="undo"></button><button type="button" data-do="redo"></button><button type="button" data-do="redraw"></button><button type="button" data-do="cancel"></button><button type="button" class="primary" data-do="done"></button></div>` : '<div class="tag"></div>'}`;
  document.documentElement.append(host);
  const svg = root.querySelector('svg');
  const pick = root.querySelector('.pick');
  const bar = root.querySelector('.bar');
  const tag = root.querySelector('.tag');
  if (bar) {
    bar.querySelector('[data-do=redraw]').textContent = L.redraw;
    bar.querySelector('[data-do=undo]').textContent = L.undo;
    bar.querySelector('[data-do=undo]').title = 'Ctrl+Z';
    bar.querySelector('[data-do=redo]').textContent = L.redo;
    bar.querySelector('[data-do=redo]').title = 'Ctrl+Y';
    bar.querySelector('[data-do=cancel]').textContent = L.cancel;
    bar.querySelector('[data-do=done]').textContent = L.done;
  }
  if (tag) tag.textContent = L.shown;
  const NS = 'http://www.w3.org/2000/svg';
  const make = (name, attrs) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };
  // Area ↔ screen coordinates (as areaOrigin in pageHelpers).
  const origin = () => {
    if (!anchorEl) return { x: -scrollX, y: -scrollY };
    const r = anchorEl.getBoundingClientRect();
    return { x: r.left + anchorEl.clientLeft - anchorEl.scrollLeft, y: r.top + anchorEl.clientTop - anchorEl.scrollTop };
  };
  const toScreen = (p) => { const o = origin(); return { x: p.x + o.x, y: p.y + o.y }; };
  const page = () => anchorEl || document.scrollingElement || document.documentElement;
  const clamp = (p) => ({
    x: Math.round(Math.min(Math.max(p.x, 0), page().scrollWidth)),
    y: Math.round(Math.min(Math.max(p.y, 0), page().scrollHeight)),
  });
  /** A point on screen, in area coordinates. */
  const fromScreen = (x, y) => { const o = origin(); return clamp({ x: x - o.x, y: y - o.y }); };
  const scrolls = (el, dx, dy) => {
    const cs = getComputedStyle(el);
    const canY = /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const canX = /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (dx === undefined) return canY || canX;
    return (dy && canY && (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1))
      || (dx && canX && (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1));
  };
  /** The panel that scrolls around an element, or null for the page. */
  const scrollerOf = (el) => {
    for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (scrolls(node)) return node;
    }
    return null;
  };
  const inside = (x, y) => {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = toScreen(pts[i]);
      const b = toScreen(pts[j]);
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };

  let rubber = null; // the rectangle being drawn, in screen coordinates
  // Undo / redo (Ctrl+Z, Ctrl+Y): the shape before each change.
  const past = [];
  const future = [];
  const current = () => ({ pts: pts.map((p) => ({ ...p })), anchorEl, phase });
  const restore = (snap) => { pts = snap.pts; anchorEl = snap.anchorEl; phase = snap.phase; };
  const remember = () => { past.push(current()); if (past.length > 100) past.shift(); future.length = 0; };
  const undo = () => { if (!past.length) return; future.push(current()); restore(past.pop()); drag = null; rubber = null; render(); };
  const redo = () => { if (!future.length) return; past.push(current()); restore(future.pop()); render(); };
  function render() {
    svg.replaceChildren();
    const W = innerWidth;
    const H = innerHeight;
    const screenPts = pts.map(toScreen);
    if (phase === 'edit' && screenPts.length >= 3) {
      const poly = screenPts.map((p) => `${p.x},${p.y}`).join(' ');
      svg.append(make('path', { class: 'dim', d: `M0,0H${W}V${H}H0Z M${screenPts.map((p) => `${p.x},${p.y}`).join(' L')}Z` }));
      svg.append(make('polygon', { class: 'halo', points: poly }));
      svg.append(make('polygon', { class: 'shape', points: poly, 'data-part': 'shape' }));
      if (editing) {
        screenPts.forEach((p, i) => {
          const q = screenPts[(i + 1) % screenPts.length];
          svg.append(make('circle', { class: 'mid', cx: (p.x + q.x) / 2, cy: (p.y + q.y) / 2, r: 4.5, 'data-part': 'mid', 'data-i': i }));
        });
        screenPts.forEach((p, i) => svg.append(make('circle', { class: drag?.kind === 'corner' && drag.i === i ? 'corner active' : 'corner', cx: p.x, cy: p.y, r: 7, 'data-part': 'corner', 'data-i': i })));
      }
      if (tag) {
        const top = Math.min(...screenPts.map((p) => p.y));
        const left = Math.min(...screenPts.map((p) => p.x));
        Object.assign(tag.style, { left: `${Math.max(4, left)}px`, top: `${top > 26 ? top - 24 : top + 4}px` });
      }
    } else {
      svg.append(make('rect', { class: 'dim', x: 0, y: 0, width: W, height: H }));
      if (rubber) {
        svg.append(make('rect', {
          class: 'rubber', x: Math.min(rubber.x0, rubber.x1), y: Math.min(rubber.y0, rubber.y1),
          width: Math.abs(rubber.x1 - rubber.x0), height: Math.abs(rubber.y1 - rubber.y0),
        }));
      }
    }
    if (bar) {
      bar.querySelector('span').textContent = phase === 'draw' ? L.draw : L.edit;
      bar.querySelector('[data-do=done]').disabled = pts.length < 3;
      bar.querySelector('[data-do=redraw]').hidden = phase === 'draw';
      // Out of the way: at the bottom when the area reaches up to where the toolbar is.
      const ys = pts.map((p) => toScreen(p).y);
      const low = ys.length >= 3 && Math.min(...ys) < bar.offsetHeight + 24 && Math.max(...ys) < innerHeight - bar.offsetHeight - 24;
      Object.assign(bar.style, low ? { top: 'auto', bottom: '12px' } : { top: '12px', bottom: 'auto' });
      bar.querySelector('[data-do=undo]').disabled = !past.length;
      bar.querySelector('[data-do=redo]').disabled = !future.length;
    }
    host.style.cursor = phase === 'draw' ? 'crosshair' : '';
  }

  /** The page element under the pointer (the overlay steps aside for a moment to find it). */
  const elementAt = (x, y) => {
    host.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    host.style.display = '';
    return el && el !== document.documentElement && el !== document.body && el.id !== 'integratedai-card' ? el : null;
  };
  const anchorSelector = () => (anchorEl ? h.cssPath(anchorEl) : '');
  const finish = (result) => {
    state.areaUi?.stop();
    if (result === 'done') areaOverlay(h, selected, { mode: 'show', points: pts, anchor: anchorSelector(), labels }); // keep the outline
    // (after that: showing the outline starts with a clean result)
    state.areaResult = { result, points: pts, anchor: anchorSelector(), url: location.href.split('#')[0] };
  };
  // The wheel scrolls what's under the pointer, as without the overlay (the page, or a panel in it).
  const wheel = (e) => {
    e.preventDefault();
    for (let node = elementAt(e.clientX, e.clientY); node && node !== document.documentElement; node = node.parentElement) {
      if (node !== document.body && scrolls(node, e.deltaX, e.deltaY)) { node.scrollBy({ left: e.deltaX, top: e.deltaY }); return; }
    }
    scrollBy({ left: e.deltaX, top: e.deltaY });
  };

  /** Is the point on the toolbar (its buttons work as buttons)? */
  const onBar = (x, y) => {
    if (!bar) return false;
    const r = bar.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  /**
   * What's under the pointer, by distance (easier to grab than the small circles themselves): a corner within
   * 12px, else a dot between corners within 10px.
   */
  const partAt = (x, y) => {
    const screenPts = pts.map(toScreen);
    const near = (p, r) => Math.hypot(p.x - x, p.y - y) <= r;
    let best = -1;
    screenPts.forEach((p, i) => { if (near(p, 12) && (best < 0 || Math.hypot(p.x - x, p.y - y) < Math.hypot(screenPts[best].x - x, screenPts[best].y - y))) best = i; });
    if (best >= 0) return { part: 'corner', i: best };
    for (let i = 0; i < screenPts.length; i++) {
      const p = screenPts[i];
      const q = screenPts[(i + 1) % screenPts.length];
      if (near({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, 10)) return { part: 'mid', i };
    }
    return { part: inside(x, y) ? 'shape' : '', i: -1 };
  };

  let drag = null;
  const down = (e) => {
    if (e.button !== 0 || onBar(e.clientX, e.clientY) || e.target?.id === 'integratedai-card') return;
    e.preventDefault();
    e.stopImmediatePropagation(); // the page's own drag handling (swiping between slides, …) doesn't get it
    const { part, i } = phase === 'draw' ? { part: '', i: -1 } : partAt(e.clientX, e.clientY);
    if (phase === 'draw' || part) remember();
    if (phase === 'draw') {
      drag = { kind: 'draw' };
      rubber = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    } else if (part === 'corner') {
      drag = { kind: 'corner', i };
    } else if (part === 'mid') {
      pts.splice(i + 1, 0, fromScreen(e.clientX, e.clientY));
      drag = { kind: 'corner', i: i + 1 };
    } else if (part === 'shape') {
      drag = { kind: 'move', x: e.clientX, y: e.clientY, from: pts.map((p) => ({ ...p })) };
    } else {
      return;
    }
    try { host.setPointerCapture(e.pointerId); } catch { /* not a pointer we can capture */ }
    render();
  };
  const move = (e) => {
    if (drag) { e.preventDefault(); e.stopImmediatePropagation(); }
    if (!drag) {
      if (phase === 'edit') {
        const { part } = partAt(e.clientX, e.clientY);
        host.style.cursor = part === 'corner' ? 'grab' : part === 'mid' ? 'copy' : part === 'shape' ? 'move' : '';
      }
      // Drawing: show which element a click would take.
      if (phase === 'draw') {
        const el = elementAt(e.clientX, e.clientY);
        const r = el?.getBoundingClientRect();
        Object.assign(pick.style, r ? { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` } : { display: 'none' });
      }
      return;
    }
    if (drag.kind === 'draw') {
      rubber.x1 = e.clientX;
      rubber.y1 = e.clientY;
      pick.style.display = 'none';
    } else if (drag.kind === 'corner') {
      pts[drag.i] = fromScreen(e.clientX, e.clientY);
    } else if (drag.kind === 'move') {
      // The whole shape, kept as it is: it stops when its edge reaches the side (instead of bending).
      let dx = e.clientX - drag.x;
      let dy = e.clientY - drag.y;
      const xs = drag.from.map((p) => p.x);
      const ys = drag.from.map((p) => p.y);
      const limit = page();
      dx = Math.min(Math.max(dx, -Math.min(...xs)), limit.scrollWidth - Math.max(...xs));
      dy = Math.min(Math.max(dy, -Math.min(...ys)), limit.scrollHeight - Math.max(...ys));
      pts = drag.from.map((p) => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }));
    }
    render();
  };
  const up = (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (drag.kind === 'draw') {
      const wide = Math.abs(rubber.x1 - rubber.x0) > 6 && Math.abs(rubber.y1 - rubber.y0) > 6;
      let box = null;
      if (wide) {
        box = { left: Math.min(rubber.x0, rubber.x1), top: Math.min(rubber.y0, rubber.y1), right: Math.max(rubber.x0, rubber.x1), bottom: Math.max(rubber.y0, rubber.y1) };
      } else {
        // A click: the box of the element under it (a little bigger, so its edges are inside).
        const r = elementAt(e.clientX, e.clientY)?.getBoundingClientRect();
        if (r && r.width && r.height) box = { left: r.left - 4, top: r.top - 4, right: r.right + 4, bottom: r.bottom + 4 };
      }
      rubber = null;
      pick.style.display = 'none';
      if (box) {
        // Attached to the panel that scrolls around its middle (or the page).
        anchorEl = scrollerOf(elementAt((box.left + box.right) / 2, (box.top + box.bottom) / 2));
        pts = [[box.left, box.top], [box.right, box.top], [box.right, box.bottom], [box.left, box.bottom]]
          .map(([x, y]) => fromScreen(x, y));
        phase = 'edit';
      }
    }
    drag = null;
    render();
  };
  const dbl = (e) => {
    const { part, i } = partAt(e.clientX, e.clientY);
    if (part !== 'corner' || pts.length <= 3) return;
    e.preventDefault();
    pts.splice(i, 1);
    render();
  };
  // The browser took the pointer away (a touch scroll, the window lost focus): keep what was done so far.
  const cancel = () => { if (drag) { if (drag.kind === 'draw') rubber = null; drag = null; render(); } };
  const command = (cmd) => {
    if (cmd === 'cancel') finish('cancel');
    else if (cmd === 'done') { if (pts.length >= 3 && phase === 'edit') finish('done'); }
    else if (cmd === 'undo') undo();
    else if (cmd === 'redo') redo();
  };
  /** Keys while marking: the shortcuts, and nothing else reaches the page (not its handlers, not its fields). */
  const key = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = String(e.key || '').toLowerCase();
    if (k === 'escape') command('cancel');
    else if (k === 'enter') command('done');
    else if (mod && !e.shiftKey && k === 'z') command('undo');
    else if (mod && (k === 'y' || (e.shiftKey && k === 'z'))) command('redo');
  };
  const KEY_EVENTS = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionstart'];
  const click = (e) => {
    const action = e.target.closest?.('button')?.dataset.do;
    if (action === 'done') finish('done');
    else if (action === 'cancel') finish('cancel');
    else if (action === 'redraw') { remember(); pts = []; anchorEl = null; phase = 'draw'; render(); }
    else if (action === 'undo') undo();
    else if (action === 'redo') redo();
  };
  const redraw = () => requestAnimationFrame(render);

  if (editing) {
    // On the window, in the capture phase: before the page's own handlers (a slide show that takes over any drag
    // to swipe, …), which then don't see the drag at all. What's grabbed is found by position (partAt).
    addEventListener('pointerdown', down, true);
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', cancel, true);
    host.addEventListener('dblclick', dbl);
    root.addEventListener('click', click);
    // (The wheel goes to the overlay itself, not into its shadow root.)
    host.addEventListener('wheel', wheel, { passive: false });
    for (const type of KEY_EVENTS) addEventListener(type, key, true);
    // Nothing on the page keeps the keyboard while marking (typing can't end up in its fields).
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
  }
  addEventListener('scroll', redraw, true);
  addEventListener('resize', redraw);
  state.areaUi = {
    command,
    stop() {
      removeEventListener('pointerdown', down, true);
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('pointercancel', cancel, true);
      for (const type of KEY_EVENTS) removeEventListener(type, key, true);
      removeEventListener('scroll', redraw, true);
      removeEventListener('resize', redraw);
      host.remove();
      state.areaUi = undefined;
    },
  };
  render();
  return true;
}

/** Does the marked area apply here (the right page or site, and its scrolling panel is there)? */
export function areaCheck(h) {
  return Boolean(h.area) && !h.wrongPage;
}

/** The area editor's keys, from the panel (where the keyboard usually is): cancel, done, undo, redo. */
export function areaCommand(h, selected, { command }) {
  h.state().areaUi?.command?.(command);
  return true;
}

/** What happened in the area editor since the last look: { result: 'done' | 'cancel', points, anchor, url } or null (still editing). */
export function areaStatus(h) {
  const state = h.state();
  const result = state.areaResult;
  state.areaResult = null;
  return result ?? (state.areaUi ? null : { result: 'gone', points: [] });
}

/**
 * The outermost elements completely inside the area (as selectors), at most 40: CSS changes are limited to
 * them (@scope), and scripts get them as $area.
 */
export function areaRoots(h) {
  if (!h.area) return [];
  const roots = [];
  const walk = (el) => {
    if (roots.length >= 40) return;
    if (h.inArea(el)) { roots.push(h.cssPath(el)); return; }
    for (const child of el.children) walk(child);
  };
  walk(document.body);
  return roots;
}

/**
 * screenshot of something inside an iframe: where the frame's content area is on the page (scrolled into view
 * if it's off-screen; restoreScroll puts the page back). The element's position inside the frame is added to it.
 */
/**
 * With a marked area: the part of it that lies in a frame, as points on that frame's screen (its viewport), for the
 * calls made in the frame (see callInPage). Runs in the page around the frame, with its area, so it is checked here
 * that this is still the page the area belongs to. Throws when the area doesn't reach into the frame.
 */
export function areaInFrame(h, selected, { url, real }) {
  h.assertPage();
  const box = frameBox(h, selected, { url, real }).box;
  if (!h.rectTouchesArea({ left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, width: box.width, height: box.height })) {
    throw new Error('That frame is outside the area the user marked');
  }
  const o = h.areaOrigin();
  return { area: h.area.map((p) => ({ x: p.x + o.x - box.x, y: p.y + o.y - box.y })), frame: true };

  // (frameBox, inlined: page functions are sent on their own)
  function frameBox(hh, sel, { url: u, real: realUrl }) {
    const parts = (a) => { try { const x = new URL(a, location.href); return { href: x.href, origin: x.origin, path: x.origin + x.pathname }; } catch { return null; } };
    const frames = [...document.querySelectorAll('iframe, frame')].map((fr) => {
      let src = fr.src;
      try { src = fr.contentWindow.location.href; } catch { /* cross-origin: its src */ }
      return { fr, at: parts(src) };
    }).filter((x) => x.at);
    const wants = [u, realUrl].filter(Boolean).map(parts).filter(Boolean);
    const pick = frames.find((x) => wants.some((w) => w.href === x.at.href))
      || frames.find((x) => wants.some((w) => w.path === x.at.path))
      || (() => { const same = frames.filter((x) => wants.some((w) => w.origin === x.at.origin)); return same.length === 1 ? same[0] : null; })();
    // None fits by address (its src moved on, or two frames share the site): the one frame the area reaches into.
    const touching = frames.filter((x) => hh.rectTouchesArea(x.fr.getBoundingClientRect()));
    const el = pick?.fr ?? (touching.length === 1 ? touching[0].fr : null);
    if (!el) {
      throw new Error(`No frame with the URL ${u} here. Frames the marked area reaches into: ${touching.map((x) => x.at.href).join(', ') || 'none'}`);
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const left = parseFloat(cs.paddingLeft) || 0;
    const top = parseFloat(cs.paddingTop) || 0;
    return {
      box: {
        x: r.left + el.clientLeft + left, y: r.top + el.clientTop + top,
        width: el.clientWidth - left - (parseFloat(cs.paddingRight) || 0), height: el.clientHeight - top - (parseFloat(cs.paddingBottom) || 0),
      },
    };
  }
}

export function frameBox(h, selected, { url }) {
  const same = (a, b) => {
    try {
      const x = new URL(a, location.href);
      const y = new URL(b);
      return x.origin === y.origin && x.pathname === y.pathname;
    } catch { return false; }
  };
  const el = [...document.querySelectorAll('iframe, frame')].find((f) => {
    let src = f.src;
    try { src = f.contentWindow.location.href; } catch { /* cross-origin: its src */ }
    return same(src, url);
  });
  if (!el) throw new Error(`No frame with the URL ${url} on the page`);
  const viewport = { width: innerWidth, height: innerHeight };
  const scroll = { x: scrollX, y: scrollY };
  let r = el.getBoundingClientRect();
  let scrolled = false;
  if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    scrolled = true;
    r = el.getBoundingClientRect();
  }
  const cs = getComputedStyle(el);
  const left = parseFloat(cs.paddingLeft) || 0;
  const top = parseFloat(cs.paddingTop) || 0;
  return {
    viewport, scroll, scrolled,
    box: {
      x: r.left + el.clientLeft + left, y: r.top + el.clientTop + top,
      width: el.clientWidth - left - (parseFloat(cs.paddingRight) || 0), height: el.clientHeight - top - (parseFloat(cs.paddingBottom) || 0),
    },
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
