// The card on the page: the basic AI panel, opened from the toolbar button (or Alt+Shift+A).
//
// The service worker injects this file into the tab (isolated world) when the button is clicked, and
// again after each page load while the card is open, so it follows the tab to other pages. It shows
// the panel (panel/panel.html?card=1) in a frame inside a closed shadow root, so the page's CSS can't
// reach it and the AI's page tools never see it (they skip #integratedai-card).
//
// The card floats over the page (bottom right by default) and leaves the rest of the page usable.
// Drag it by its header to move it; drag it against the left or right edge, or use the dock button,
// to make it a full-height side panel. Edges and corners resize it. It can fade while the mouse is
// elsewhere (the ◐ button: off / light / strong), minimise to a small pill, and close. Its place and
// size are remembered (chrome.storage.local "cardLayout"); whether it is open, per tab, by the worker.
(() => {
  const ID = 'integratedai-card';
  // Injected again into a page where it already runs: just apply the open/closed state again.
  if (globalThis.__integratedaiCard) {
    globalThis.__integratedaiCard.sync();
    return;
  }

  const MIN_W = 320;
  const MIN_H = 360;
  const MARGIN = 16;
  const SNAP = 24; // dragging this close to the left/right edge docks the card there
  const FADE = { off: 1, light: 0.7, strong: 0.45 };
  const FADE_NEXT = { off: 'light', light: 'strong', strong: 'off' };
  const FADE_TITLE = { off: 'See-through: off', light: 'See-through: light', strong: 'See-through: strong' };

  /** @type {{ mode: 'float' | 'left' | 'right', x: number, y: number, w: number, h: number, fade: 'off' | 'light' | 'strong' }} */
  let layout = { mode: 'float', x: -1, y: -1, w: 400, h: 640, fade: 'light' };
  let host = null;
  let root = null;
  let card = null;
  let frame = null;
  let pill = null;
  let hovered = false;
  let minimized = false;
  /** The DevTools panel took over this tab: reload the frame when the card comes back (fresh conversation state). */
  let staleFrame = false;

  const ask = (cmd, extra = {}) => chrome.runtime.sendMessage({ ...extra, cmd }).then((r) => (r?.ok ? r.value : null)).catch(() => null);

  // ── open / close

  async function sync() {
    const state = await ask('card.get');
    if (!state?.open) { remove(); return; }
    if (!host) await build(state.tabId);
    setMinimized(Boolean(state.minimized));
  }

  async function build(tabId) {
    layout = { ...layout, ...((await chrome.storage.local.get('cardLayout')).cardLayout ?? {}) };
    host = document.createElement('div');
    host.id = ID;
    // All of it sits above the page; only the card and the pill take clicks.
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${STYLE}</style>
      <section class="card" role="dialog" aria-label="IntegratedAI">
        <div class="bar">
          <span class="title">${ICON}IntegratedAI</span>
          <span class="spacer"></span>
          <button type="button" data-do="fade">${GLYPH.fade}</button>
          <button type="button" data-do="dock">${GLYPH.dock}</button>
          <button type="button" data-do="minimize" title="Minimise" aria-label="Minimise">${GLYPH.minimize}</button>
          <button type="button" data-do="close" title="Close" aria-label="Close">${GLYPH.close}</button>
        </div>
        <iframe title="IntegratedAI" allow="clipboard-write"></iframe>
        ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => `<div class="edge ${edge}" data-edge="${edge}"></div>`).join('')}
      </section>
      <div class="snap" hidden></div>
      <button type="button" class="pill" hidden>${ICON}<span>IntegratedAI</span></button>`;
    card = root.querySelector('.card');
    frame = root.querySelector('iframe');
    pill = root.querySelector('.pill');
    frame.src = chrome.runtime.getURL(`panel/panel.html?card=1&tabId=${tabId}`);
    document.documentElement.append(host);

    root.querySelector('[data-do=fade]').addEventListener('click', () => { layout.fade = FADE_NEXT[layout.fade]; save(); place(); });
    root.querySelector('[data-do=dock]').addEventListener('click', () => { layout.mode = layout.mode === 'float' ? 'right' : 'float'; save(); place(); });
    root.querySelector('[data-do=minimize]').addEventListener('click', () => { setMinimized(true); ask('card.set', { minimized: true }); });
    root.querySelector('[data-do=close]').addEventListener('click', () => { ask('card.set', { open: false }); remove(); });
    pill.addEventListener('click', () => { setMinimized(false); ask('card.set', { minimized: false }); });
    card.addEventListener('pointerenter', () => { hovered = true; fade(); });
    card.addEventListener('pointerleave', () => { hovered = false; fade(); });
    addEventListener('resize', place);
    root.querySelector('.bar').addEventListener('pointerdown', startDrag);
    for (const edge of root.querySelectorAll('.edge')) edge.addEventListener('pointerdown', startResize);
    // Esc in the panel (it can't reach this page's keyboard events) minimises the card.
    addEventListener('message', (e) => {
      if (e.source !== frame?.contentWindow || e.data?.integratedai !== 'minimize') return;
      setMinimized(true);
      ask('card.set', { minimized: true });
    });
    place();
  }

  function remove() {
    unpush();
    host?.remove();
    host = root = card = frame = pill = null;
    removeEventListener('resize', place);
  }

  /** @param {boolean} value */
  function setMinimized(value, note = '') {
    minimized = value;
    if (!card) return;
    card.hidden = value;
    pill.hidden = !value;
    pill.querySelector('span').textContent = note || 'IntegratedAI';
    place(); // docked: the page gets its room back while minimised, and loses it again after
    if (!value && staleFrame) {
      staleFrame = false;
      frame.src = frame.src; // the conversation went on in DevTools: load its current state
    }
    fade();
  }

  // ── place, size, fade

  function save() {
    chrome.storage.local.set({ cardLayout: layout }).catch(() => {});
  }

  /** Put the card where the layout says, kept inside the window. */
  function place() {
    if (!card) return;
    const vw = innerWidth;
    const vh = innerHeight;
    const w = Math.min(Math.max(layout.w, MIN_W), vw - (layout.mode === 'float' ? 2 * MARGIN : 0));
    card.dataset.mode = layout.mode;
    if (layout.mode === 'float') {
      const h = Math.min(Math.max(layout.h, MIN_H), vh - 2 * MARGIN);
      // First time: bottom right.
      const x = layout.x < 0 ? vw - w - MARGIN : Math.min(Math.max(layout.x, 0), vw - w);
      const y = layout.y < 0 ? vh - h - MARGIN : Math.min(Math.max(layout.y, 0), vh - h);
      Object.assign(card.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    } else {
      Object.assign(card.style, { left: layout.mode === 'left' ? '0px' : `${vw - w}px`, top: '0px', width: `${w}px`, height: `${vh}px` });
    }
    push(layout.mode === 'float' || minimized ? 0 : w);
    const fadeButton = root.querySelector('[data-do=fade]');
    fadeButton.title = `${FADE_TITLE[layout.fade]} (when the mouse is elsewhere)`;
    fadeButton.setAttribute('aria-label', fadeButton.title);
    fadeButton.dataset.level = layout.fade;
    const dockButton = root.querySelector('[data-do=dock]');
    dockButton.title = layout.mode === 'float' ? 'Dock to the right side' : 'Float';
    dockButton.setAttribute('aria-label', dockButton.title);
    fade();
  }

  /**
   * Floating: solid while the mouse is over it, see-through otherwise (as chosen with ◐), also while
   * its text box has focus, so the page shows through as soon as you look back at it. Docked, it
   * pushes the page aside instead of covering it, so it stays solid.
   */
  function fade() {
    if (!card) return;
    const solid = hovered || dragging || layout.mode !== 'float';
    card.style.opacity = String(solid ? 1 : FADE[layout.fade]);
  }

  // ── docked: the page moves aside

  /**
   * While docked, the page is made narrower by the panel's width instead of being covered: a margin on
   * <html> moves its content, and fixed elements that reach that edge (headers, chat buttons, cookie
   * bars), which a margin doesn't move, are narrowed or shifted. Everything changed is put back exactly
   * when the card floats, is minimised or closes. (Chrome's own side panel can do this natively, but it
   * can't be dragged out into a floating card again.)
   */
  let pushed = { side: '', width: 0, vw: 0 };
  /** @type {Map<HTMLElement, Record<string, [string, string]>>} element → original inline values it had */
  const moved = new Map();
  let pushObserver = null;
  let pushTimer = 0;

  /** @param {number} width 0 = give the page all its room back */
  function push(width) {
    const side = width ? layout.mode : '';
    // (Same place, same window size: nothing to do. A resized window needs the fixed bars measured again.)
    if (side === pushed.side && width === pushed.width && (!width || innerWidth === pushed.vw)) return;
    unpush();
    if (!width) return;
    pushed = { side, width, vw: innerWidth };
    const html = document.documentElement;
    remember(html, [`margin-${side}`]);
    html.style.setProperty(`margin-${side}`, `${width}px`, 'important');
    adjustFixed();
    // Pages add fixed bars later (on scroll, after loading): look again shortly after changes.
    pushObserver = new MutationObserver(() => {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(adjustFixed, 500);
    });
    pushObserver.observe(document.body, { childList: true, subtree: true });
  }

  function unpush() {
    pushObserver?.disconnect();
    pushObserver = null;
    clearTimeout(pushTimer);
    for (const [el, props] of moved) {
      for (const [prop, [value, priority]] of Object.entries(props)) {
        if (value) el.style.setProperty(prop, value, priority);
        else el.style.removeProperty(prop);
      }
    }
    moved.clear();
    pushed = { side: '', width: 0, vw: 0 };
  }

  /** Keep an element's original inline values (once) so unpush can restore them. */
  function remember(el, props) {
    const saved = moved.get(el) ?? {};
    for (const prop of props) if (!(prop in saved)) saved[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
    moved.set(el, saved);
  }

  /** Fixed elements touching the docked edge: full-width ones get narrower, small ones move inward. */
  function adjustFixed() {
    const { side, width } = pushed;
    if (!side) return;
    const vw = innerWidth;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(), seen = 0; el && seen < 8000; el = walker.nextNode(), seen++) {
      if (moved.has(el) || el === host || getComputedStyle(el).position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const touches = side === 'right' ? r.right >= vw - 2 : r.left <= 2;
      if (!touches) continue;
      if (r.width >= vw * 0.5) {
        // A bar across the page: as wide as the page's remaining room.
        remember(el, ['width', 'max-width', ...(side === 'left' ? ['left'] : [])]);
        el.style.setProperty('width', `${Math.max(r.width - width, 0)}px`, 'important');
        el.style.setProperty('max-width', `${vw - width}px`, 'important');
        if (side === 'left') el.style.setProperty('left', `${r.left + width}px`, 'important');
      } else {
        // Something small at the edge (a chat button): move it inward by the panel's width.
        remember(el, ['left', 'right']);
        if (side === 'right') {
          el.style.setProperty('right', `${vw - r.right + width}px`, 'important');
          el.style.setProperty('left', 'auto', 'important');
        } else {
          el.style.setProperty('left', `${r.left + width}px`, 'important');
          el.style.setProperty('right', 'auto', 'important');
        }
      }
    }
  }

  // ── dragging and resizing

  let dragging = false;

  /** Drag by the header: move the card; release near the left or right edge to dock it there. */
  function startDrag(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, ...card.getBoundingClientRect().toJSON() };
    const snap = root.querySelector('.snap');
    let side = null;
    begin(e, (ev) => {
      // A docked card follows the mouse as a floating one again (at its floating size).
      if (layout.mode !== 'float') {
        layout.mode = 'float';
        start.width = Math.min(Math.max(layout.w, MIN_W), innerWidth - 2 * MARGIN);
        start.height = Math.min(Math.max(layout.h, MIN_H), innerHeight - 2 * MARGIN);
        start.left = ev.clientX - start.width / 2;
        start.top = ev.clientY - 14;
        start.px = ev.clientX;
        start.py = ev.clientY;
      }
      layout.x = start.left + ev.clientX - start.px;
      layout.y = start.top + ev.clientY - start.py;
      place();
      side = ev.clientX < SNAP ? 'left' : ev.clientX > innerWidth - SNAP ? 'right' : null;
      snap.hidden = !side;
      if (side) snap.dataset.side = side;
    }, () => {
      snap.hidden = true;
      if (side) layout.mode = side;
      save();
      place();
    });
  }

  /** Drag an edge or corner: resize (a docked card only on its inner edge). */
  function startResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const edge = e.currentTarget.dataset.edge;
    const start = { px: e.clientX, py: e.clientY, ...card.getBoundingClientRect().toJSON() };
    begin(e, (ev) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      if (layout.mode !== 'float') {
        layout.w = Math.max(MIN_W, start.width + (layout.mode === 'right' ? -dx : dx));
      } else {
        let { left, top, width, height } = start;
        if (edge.includes('e')) width = start.width + dx;
        if (edge.includes('s')) height = start.height + dy;
        if (edge.includes('w')) { width = start.width - dx; left = start.left + dx; }
        if (edge.includes('n')) { height = start.height - dy; top = start.top + dy; }
        if (width < MIN_W) { if (edge.includes('w')) left -= MIN_W - width; width = MIN_W; }
        if (height < MIN_H) { if (edge.includes('n')) top -= MIN_H - height; height = MIN_H; }
        Object.assign(layout, { x: left, y: top, w: width, h: height });
      }
      place();
    }, save);
  }

  /** Follow the pointer until it is released; the frame doesn't take pointer events meanwhile. */
  function begin(e, onMove, onEnd) {
    dragging = true;
    card.classList.add('moving');
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(ev);
    const up = () => {
      dragging = false;
      card.classList.remove('moving');
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      onEnd();
      fade();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  // ── messages from the worker

  chrome.runtime.onMessage.addListener((msg) => {
    // The AI tab in DevTools opened on this tab: it continues the conversation, so step aside.
    if (msg?.type === 'card.devtools' && host) {
      staleFrame = true;
      setMinimized(true, 'IntegratedAI · continued in DevTools');
    }
  });

  globalThis.__integratedaiCard = { sync };
  sync();

  // ── look: the DevTools panel's greys, one blue accent, 1px borders, small corners, line icons

  const ICON = '<svg class="logo" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M2.5 2.5h7v4"/><path d="M2.5 2.5v7h4"/><path d="m8 8 5.5 2-2.3.9-.9 2.3z"/></svg>';
  const svg = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const GLYPH = {
    fade: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11" /><path d="M8 4.5h3M8 7h4.5M8 9.5h4M8 12h2" stroke-width="1"/>'),
    dock: svg('<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M10 3v10"/>'),
    minimize: svg('<path d="M4 8h8"/>'),
    close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  };

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card, .pill { --bg: #fff; --bar: #f1f3f4; --fg: #202124; --muted: #5f6368; --border: #dadce0; --accent: #1a73e8; --hover: #e8eaed; }
    @media (prefers-color-scheme: dark) {
      .card, .pill { --bg: #202124; --bar: #292a2d; --fg: #e8eaed; --muted: #9aa0a6; --border: #3c4043; --accent: #8ab4f8; --hover: #35363a; }
    }
    .card {
      position: fixed; display: flex; flex-direction: column; pointer-events: auto;
      background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, .18); overflow: hidden;
      font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      transition: opacity .15s;
    }
    .card[hidden] { display: none; }
    .card[data-mode="right"] { border-radius: 0; border-width: 0 0 0 1px; box-shadow: none; }
    .card[data-mode="left"] { border-radius: 0; border-width: 0 1px 0 0; box-shadow: none; }
    .bar { display: flex; align-items: center; gap: 2px; height: 28px; padding: 0 4px 0 8px; background: var(--bar);
      border-bottom: 1px solid var(--border); cursor: move; user-select: none; touch-action: none; flex: none; }
    .title { display: flex; align-items: center; gap: 6px; font-weight: 600; color: var(--fg); }
    .logo { width: 14px; height: 14px; color: var(--accent); flex: none; }
    .spacer { flex: 1; }
    .bar button, .pill { font: inherit; color: var(--muted); background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
    .bar button { width: 24px; height: 22px; display: grid; place-items: center; padding: 0; }
    .bar button:hover { background: var(--hover); color: var(--fg); }
    .bar button:focus-visible, .pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .bar button svg { width: 14px; height: 14px; }
    .bar button[data-level="off"] { color: var(--muted); }
    .bar button[data-level="light"], .bar button[data-level="strong"] { color: var(--accent); }
    iframe { flex: 1; width: 100%; border: 0; background: var(--bg); color-scheme: normal; }
    .card.moving iframe { pointer-events: none; }
    .edge { position: absolute; z-index: 1; touch-action: none; }
    .edge.n, .edge.s { left: 8px; right: 8px; height: 6px; cursor: ns-resize; }
    .edge.e, .edge.w { top: 8px; bottom: 8px; width: 6px; cursor: ew-resize; }
    .edge.n { top: -3px; } .edge.s { bottom: -3px; } .edge.e { right: -3px; } .edge.w { left: -3px; }
    .edge.ne, .edge.nw, .edge.se, .edge.sw { width: 12px; height: 12px; }
    .edge.ne { top: -3px; right: -3px; cursor: nesw-resize; } .edge.sw { bottom: -3px; left: -3px; cursor: nesw-resize; }
    .edge.nw { top: -3px; left: -3px; cursor: nwse-resize; } .edge.se { bottom: -3px; right: -3px; cursor: nwse-resize; }
    .card[data-mode="right"] .edge:not(.w), .card[data-mode="left"] .edge:not(.e) { display: none; }
    .card[data-mode="right"] .edge.w, .card[data-mode="left"] .edge.e { top: 0; bottom: 0; }
    .snap { position: fixed; top: 0; bottom: 0; width: 400px; background: rgba(26, 115, 232, .12); border: 2px dashed #1a73e8; pointer-events: none; }
    .snap[data-side="left"] { left: 0; } .snap[data-side="right"] { right: 0; }
    .snap[hidden] { display: none; }
    .pill { position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 6px; padding: 6px 12px;
      background: var(--bg); color: var(--fg); border-color: var(--border); box-shadow: 0 2px 10px rgba(0, 0, 0, .18); pointer-events: auto; }
    .pill:hover { background: var(--hover); }
    .pill[hidden] { display: none; }
  `;
})();
