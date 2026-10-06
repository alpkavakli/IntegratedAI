// @ts-nocheck
/**
 * The `interact` action, inside the inspected page: click, hover, type, select, check,
 * submit, scroll, press a key, wait.
 *
 * These run via callInPage (see inspected.js), so like page-scripts.js each
 * exported function must be self-contained (no imports, no module variables)
 * and gets (h = pageHelpers(), selected = $0, args).
 *
 * Why not just set attributes? Frameworks (React, Vue, Angular, MUI) keep their
 * own state and only update it from events. So we:
 *   - click with a full pointer/mouse sequence and element.click() (which also
 *     performs the default action: toggling a radio, following a link, …)
 *   - type with the browser's own "insert text" editing command, which fires the same
 *     beforeinput/input events as typing (rich editors like the ones in chat apps
 *     only listen to those); if that doesn't take, set the value through the native
 *     setter and fire input/change (React ignores `el.value = x` without this)
 *
 * The panel runs one step at a time and retries a step for up to 5 s while its
 * element doesn't exist yet (e.g. a menu that opens after the previous click).
 */

/**
 * Run one step. Returns { found: false } if the element isn't there (yet).
 *
 * With dry: true nothing happens: the step's target is found, outlined on the page with a
 * label (so the user can follow the AI working), and described, including whether the step
 * is risky (the agent modes ask before those). With hold: true the outline stays until the
 * step runs (or clearHighlight), so it marks the target while the user is asked.
 * @returns {{ found: false } | { found: true, did: string, undoable: boolean }
 *   | { found: true, what: string, risky: string }}  risky: why it is, or ''
 */
export function interactStep(h, selected, { actionId, step, dry = false, hold = false }) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = h.visible;
  const humanName = h.humanName;
  const textOf = (el) => norm(
    el.innerText || (el.type === 'password' ? '' : el.value) || el.getAttribute('aria-label') || el.getAttribute('title')
    || el.getAttribute('placeholder') || (el.labels && el.labels[0] && el.labels[0].innerText) || '',
  );
  const fire = (target, type, Ctor = Event, init = {}) =>
    target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));

  /** Where a person would point: the middle of the element. */
  const pointAt = (target) => {
    const r = target.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
  };
  /** Move the (virtual) mouse onto the element: what hover menus and tooltips listen to. */
  const hoverOver = (target) => {
    const pos = pointAt(target);
    const pointer = { ...pos, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    fire(target, 'pointerover', PointerEvent, pointer);
    fire(target, 'pointerenter', PointerEvent, { ...pointer, bubbles: false });
    fire(target, 'mouseover', MouseEvent, pos);
    fire(target, 'mouseenter', MouseEvent, { ...pos, bubbles: false });
    fire(target, 'pointermove', PointerEvent, pointer);
    fire(target, 'mousemove', MouseEvent, pos);
  };
  /** A real-looking click: pointer + mouse events, focus, then click() for the default action. */
  const realClick = (target) => {
    hoverOver(target);
    const pos = { ...pointAt(target), button: 0, detail: 1 };
    const pointer = { ...pos, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    fire(target, 'pointerdown', PointerEvent, { ...pointer, buttons: 1 });
    fire(target, 'mousedown', MouseEvent, { ...pos, buttons: 1 });
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    fire(target, 'pointerup', PointerEvent, pointer);
    fire(target, 'mouseup', MouseEvent, pos);
    target.click();
  };

  /**
   * What a real click at the element's middle would hit instead of it (a cookie banner,
   * an overlay), or null. The click still goes to the element; the AI is told.
   */
  const coveredBy = (target) => {
    const { clientX: x, clientY: y } = pointAt(target);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    let top = document.elementFromPoint(x, y);
    while (top && top.shadowRoot) {
      const inner = top.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    if (!top || top === target || target.contains(top) || top.contains(target)) return null;
    const label = top.closest('label');
    if (label && (label.control === target || label.contains(target))) return null;
    return top;
  };

  /** Set value/checked through the prototype's setter so framework trackers notice. */
  const setNative = (target, prop, value) => {
    let proto = Object.getPrototypeOf(target);
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc && desc.set) { desc.set.call(target, value); return; }
      proto = Object.getPrototypeOf(proto);
    }
    target[prop] = value;
  };

  /**
   * Replace a field's text the way typing does: select what's there and insert the new
   * text with the browser's editing command (real beforeinput/input events, so editors in
   * chat apps and React fields update their state). Returns false if the field didn't take it.
   */
  const insertText = (target, value) => {
    target.focus({ preventScroll: true });
    if (target.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } else if (typeof target.select === 'function') {
      target.select();
    }
    try {
      if (!(value ? document.execCommand('insertText', false, value) : document.execCommand('delete'))) return false;
    } catch {
      return false;
    }
    const now = target.isContentEditable ? target.innerText : target.value;
    return norm(now) === norm(value);
  };

  /** How many elements matched the step's text (more than one: the AI is told it got the first). */
  let matches = 0;
  function find() {
    if (step.ref) return h.byRef(step.ref); // throws when the element is gone: looking again won't help
    let scope = [document.body];
    if (step.selector) {
      let list;
      try { list = h.queryAll(step.selector); } catch { throw new Error(`Invalid selector: ${step.selector}`); }
      if (!step.text) {
        const shown = list.filter(visible);
        matches = shown.length || list.length;
        return shown[0] || list[0] || null;
      }
      scope = list;
    }
    const want = norm(step.text);
    const CANDIDATES = 'button, a, label, input, select, textarea, option, summary, [role], [tabindex], li, td, th, span, div, p, h1, h2, h3, h4';
    const candidates = [];
    for (const root of scope) {
      if (root !== document.body) candidates.push(root);
      candidates.push(...h.queryAll(CANDIDATES, root));
    }
    const usable = candidates.filter((el) => el !== document.body && el !== document.documentElement && visible(el));
    let pool = usable.filter((el) => textOf(el) === want);
    if (!pool.length) pool = usable.filter((el) => textOf(el).startsWith(want));
    if (!pool.length && want.length > 2) pool = usable.filter((el) => textOf(el).includes(want));
    // The most specific matches: ones that don't contain another match.
    const innermost = pool.filter((el) => !pool.some((other) => other !== el && el.contains(other)));
    matches = innermost.length;
    return innermost[0] || null;
  }

  /** Outline the target and say what is about to happen (removed after a moment). */
  const highlight = (target, label) => {
    const ID = 'integratedai-highlight';
    document.getElementById(ID)?.remove();
    const box = document.createElement('div');
    box.id = ID;
    const r = target ? target.getBoundingClientRect() : { left: 8, top: 8, width: innerWidth - 16, height: innerHeight - 16 };
    box.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;left:${r.left - 3}px;top:${r.top - 3}px;`
      + `width:${r.width + 6}px;height:${r.height + 6}px;border:2px solid #1a73e8;border-radius:6px;`
      + 'box-shadow:0 0 0 4px rgba(26,115,232,.25);transition:opacity .3s';
    const tag = document.createElement('div');
    tag.textContent = `IntegratedAI: ${label}`;
    tag.style.cssText = 'position:absolute;left:-2px;top:-26px;background:#1a73e8;color:#fff;font:600 12px/1.6 system-ui,sans-serif;'
      + 'padding:1px 8px;border-radius:6px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis';
    if (r.top < 30) tag.style.top = `${r.height + 6}px`;
    box.append(tag);
    document.documentElement.append(box);
    if (!hold) fadeHighlight(1600);
  };
  /** Fade out and remove the outline shown now, after a moment (not one drawn later for the next step). */
  const fadeHighlight = (delay) => {
    const box = document.getElementById('integratedai-highlight');
    if (!box) return;
    setTimeout(() => {
      box.style.opacity = '0';
      setTimeout(() => box.remove(), 400);
    }, delay);
  };
  // Doing the step: the outline that marked it fades shortly after.
  if (!dry) fadeHighlight(700);

  /** Why a step needs the user's OK even in Auto mode ('' = it doesn't). */
  const riskOf = (target) => {
    if (step.action === 'submit') return 'submits a form';
    if (step.action === 'press' && /^enter$/i.test(step.value)) return 'presses Enter, which may send or submit';
    if (step.action === 'type' && target && target.matches('input[type=password], [autocomplete=one-time-code], [autocomplete*=password]')) {
      return 'types into a password field';
    }
    if (step.action === 'click' && target) {
      const button = target.closest('button, a, input[type=submit], input[type=button], [role=button]') || target;
      if (button.matches('button[type=submit], input[type=submit]') || (button.tagName === 'BUTTON' && !button.getAttribute('type') && button.form)) {
        return 'submits a form';
      }
      const words = norm(`${textOf(button)} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`);
      const risky = /\b(send|submit|pay|buy|order|purchase|checkout|check out|delete|remove|confirm|transfer|post|publish|share|sign out|log ?out|unsubscribe|book|reserve|place order|donate|subscribe|cancel subscription)\b/;
      const match = words.match(risky);
      if (match) return `clicks "${match[0]}"`;
    }
    return '';
  };

  /** The visible text of the <select> option a step means (by value or text), for describing it. */
  const optionText = (select) => {
    if (!select || select.tagName !== 'SELECT') return '';
    const want = norm(step.value);
    const option = [...select.options].find((o) => norm(o.value) === want || norm(o.text) === want);
    return option ? option.text.trim() : '';
  };
  const VERBS = { click: 'click', hover: 'point at', type: 'type into', select: 'choose in', check: 'tick', uncheck: 'untick', submit: 'submit the form of', scroll: 'scroll', press: 'press', wait: 'wait for' };

  // Steps that don't need a target: scroll the page, press a key on what has focus, pause.
  const targetless = !step.selector && !step.text && !step.ref;
  if (targetless && ['scroll', 'press', 'wait'].includes(step.action)) {
    if (dry) {
      const focused = document.activeElement;
      const what = step.action === 'scroll' ? `scroll the page ${step.value}`
        : step.action === 'press' ? `press ${step.value}${focused && focused !== document.body ? ` in ${humanName(focused)}` : ''}` : `wait ${step.value} s`;
      if (step.action !== 'wait') highlight(step.action === 'press' ? document.activeElement : null, what);
      return { found: true, what, risky: riskOf(document.activeElement) };
    }
    if (step.action === 'wait') return { found: true, did: `waited ${step.value} s`, undoable: true };
    if (step.action === 'press') return pressKey(document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body);
    return scrollBy(document.scrollingElement || document.documentElement);
  }

  const el = find();
  if (!el) return { found: false };
  if (dry) {
    // Said the way a person would: 'type "NTU" into the "Search" field', 'press Enter in …', 'click button "Send"'.
    const value = String(step.value ?? '').slice(0, 40);
    const what = step.action === 'type' ? `type "${value}" into ${humanName(field(el))}`
      : step.action === 'select' ? `choose "${optionText(field(el)) || value}" in ${humanName(field(el))}`
        : step.action === 'press' ? `press ${step.value} in ${humanName(el)}`
          : step.action === 'scroll' ? (step.value ? `scroll ${humanName(el)} ${step.value}` : `scroll to ${humanName(el)}`)
            : `${VERBS[step.action] ?? step.action} ${humanName(el)}`;
    if (step.action !== 'scroll' || step.value === undefined) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    highlight(el, what);
    return { found: true, what, risky: riskOf(el) };
  }
  if (step.action !== 'scroll') el.scrollIntoView({ block: 'center', inline: 'nearest' });

  /** Scroll an element's scrollable area (or the element's nearest scrollable ancestor) by step.value. */
  function scrollBy(node) {
    let box = node;
    while (box && box !== document.documentElement) {
      const cs = getComputedStyle(box);
      if (box.scrollHeight > box.clientHeight + 4 && /(auto|scroll|overlay)/.test(cs.overflowY)) break;
      box = box.parentElement;
    }
    box = box || document.scrollingElement || document.documentElement;
    const page = box === document.documentElement || box === document.body || box === document.scrollingElement;
    const height = page ? innerHeight : box.clientHeight;
    const before = page ? scrollY : box.scrollTop;
    const to = { down: before + height * 0.8, up: before - height * 0.8, top: 0, bottom: (page ? document.documentElement : box).scrollHeight }[step.value];
    if (page) scrollTo({ top: to, behavior: 'instant' }); else box.scrollTop = to;
    const after = page ? scrollY : box.scrollTop;
    return {
      found: true,
      did: after === before ? `couldn't scroll ${step.value} (already at the ${step.value === 'up' || step.value === 'top' ? 'top' : 'bottom'})` : `scrolled ${page ? 'the page' : h.label(box)} ${step.value}`,
      undoable: true,
    };
  }

  /** Press a key: keydown/keypress/keyup; Enter in a form field also submits it, as a real Enter would. */
  function pressKey(target) {
    const key = step.value;
    const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Space: 32 }[key] || 0 };
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    const notCancelled = fire(target, 'keydown', KeyboardEvent, init);
    if (key === 'Enter' || key.length === 1) fire(target, 'keypress', KeyboardEvent, init);
    fire(target, 'keyup', KeyboardEvent, init);
    if (notCancelled && key === 'Enter' && target.matches && target.matches('input:not([type=button]):not([type=submit])') && target.form) {
      if (typeof target.form.requestSubmit === 'function') target.form.requestSubmit(); else target.form.submit();
    }
    return { found: true, did: `pressed ${key} on ${h.label(target)}`, undoable: false };
  }

  const state = h.state();
  state.interact = state.interact || {};
  const undo = (state.interact[actionId] = state.interact[actionId] || []);
  const name = `${step.ref ? `${step.ref} ` : ''}${h.label(el)}${step.text ? ` "${step.text}"` : ''}`;
  // Several elements fit the step: say which one was used, so the AI can pick another by ref.
  const which = matches > 1 ? ` (the first of ${matches} matches; use a ref from find_elements or page_outline for another one)` : '';
  /** The form field an element stands for (itself, its label's control, or a field inside it). Hoisted: the dry run uses it. */
  function field(node) {
    return node.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || node.isContentEditable
      ? node
      : node.control || node.querySelector('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || node;
  }

  switch (step.action) {
    case 'click': {
      const control = el.closest('button, input, select, textarea, fieldset');
      if (control && control.disabled) throw new Error(`${humanName(el)} is disabled (greyed out), so it can't be clicked yet`);
      const cover = coveredBy(el);
      const link = el.closest('a[href]');
      realClick(el);
      const notes = [];
      if (cover) notes.push(`${humanName(cover)} (${h.label(cover)}) was on top of it, so a person couldn't have clicked it; close that first if nothing happened`);
      if (el.getAttribute('aria-disabled') === 'true') notes.push('it is marked as disabled, so it may have done nothing');
      if (link && link.target === '_blank') notes.push(`it opens in a new tab, which the panel can't follow; use navigate with ${link.href} to open it here`);
      return { found: true, did: `clicked ${name}${which}${notes.length ? `. Note: ${notes.join('; ')}` : ''}`, undoable: false };
    }

    case 'hover':
      hoverOver(el);
      return { found: true, did: `pointed at ${name}${which}`, undoable: true };

    case 'type': {
      const target = field(el);
      if (!target.isContentEditable && !('value' in target)) throw new Error(`${name} is not a text field`);
      if (target.disabled || target.readOnly) throw new Error(`${humanName(target)} is ${target.disabled ? 'disabled' : 'read-only'}`);
      const before = target.isContentEditable ? target.innerHTML : target.value;
      undo.push({ el: target, kind: target.isContentEditable ? 'html' : 'value', before });
      if (!insertText(target, step.value)) {
        // The editing command didn't take (some field types, unusual editors): set it directly.
        if (target.isContentEditable) {
          target.textContent = step.value;
          fire(target, 'input', InputEvent, { inputType: 'insertText', data: step.value });
        } else {
          setNative(target, 'value', step.value);
          fire(target, 'input', InputEvent, { inputType: 'insertText', data: step.value });
          fire(target, 'change');
        }
      } else if (!target.isContentEditable) {
        fire(target, 'change');
      }
      return { found: true, did: `typed "${step.value.slice(0, 60)}" into ${name}${which}`, undoable: true };
    }

    case 'select': {
      const target = field(el);
      if (target.tagName !== 'SELECT') throw new Error(`${name} is not a <select>; open a custom dropdown with click steps instead`);
      const want = norm(step.value);
      const option = [...target.options].find((o) => norm(o.value) === want || norm(o.text) === want)
        || [...target.options].find((o) => norm(o.text).includes(want));
      if (!option) throw new Error(`No option "${step.value}" in ${name}; the options are: ${[...target.options].slice(0, 30).map((o) => `"${o.text.trim()}"`).join(', ')}`);
      undo.push({ el: target, kind: 'value', before: target.value });
      setNative(target, 'value', option.value);
      fire(target, 'input');
      fire(target, 'change');
      return { found: true, did: `selected "${option.text.trim()}" in ${name}`, undoable: true };
    }

    case 'check':
    case 'uncheck': {
      const want = step.action === 'check';
      const target = field(el);
      const isNative = target.matches('input[type=checkbox], input[type=radio]');
      const checked = isNative ? target.checked : el.getAttribute('aria-checked') === 'true';
      if (checked === want) return { found: true, did: `${humanName(target)} was already ${want ? 'ticked' : 'unticked'}`, undoable: true };
      if (isNative && target.type === 'radio') {
        if (!want) throw new Error('A radio button cannot be unchecked; check another option instead');
        const group = target.name ? [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(target.name)}"]`)] : [];
        undo.push({ el: group.find((r) => r.checked) || null, kind: 'radio' });
      } else {
        undo.push({ el: isNative ? target : el, kind: 'toggle' });
      }
      // Click the visible part: hidden native inputs (common in UI kits) don't take real clicks.
      realClick(isNative && !visible(target) ? (target.labels && target.labels[0]) || el : (isNative ? target : el));
      return { found: true, did: `${want ? 'checked' : 'unchecked'} ${name}${which}`, undoable: true };
    }

    case 'scroll':
      if (step.value === undefined) return { found: true, did: `scrolled ${name} into view`, undoable: true };
      return scrollBy(el);

    case 'press':
      return pressKey(el);

    case 'wait':
      return { found: true, did: `waited for ${name}`, undoable: true };

    case 'submit': {
      const form = el.tagName === 'FORM' ? el : el.closest('form');
      if (!form) throw new Error(`${name} is not inside a form; click its submit button instead`);
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return { found: true, did: `submitted the form of ${name}`, undoable: false };
    }

    default:
      throw new Error(`Unknown step action "${step.action}"`);
  }
}

/**
 * How long the page has been quiet: no elements added or removed and no text changed
 * (our own outline and badge don't count). The first call starts watching and reports 0.
 * After a step the panel waits until the page is quiet for a moment, so the AI sees the
 * result (a list that loaded, a new route) without adding wait steps.
 */
export function quietFor(h) {
  const state = h.state();
  if (!state.quiet) {
    const own = (node) => node.nodeType === 1 && (node.id === 'integratedai-highlight' || node.id === 'integratedai-working');
    state.quiet = { last: Date.now() };
    new MutationObserver((records) => {
      if (records.every((r) => [...r.addedNodes, ...r.removedNodes].every(own) && r.type === 'childList')) return;
      state.quiet.last = Date.now();
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    return { url: location.href, ready: document.readyState, quietMs: 0 };
  }
  return { url: location.href, ready: document.readyState, quietMs: Date.now() - state.quiet.last };
}

/**
 * While the AI works on the page (agent modes): a small badge in the page's corner with a
 * Stop button, so the user can stop it without going back to DevTools. Shown again after
 * every page load (the panel calls this repeatedly), in a shadow root so page CSS can't touch it.
 * Clicking Stop leaves a request in the page's hidden state; takeStopRequest() reads it.
 */
export function showWorkingBadge(h) {
  const ID = 'integratedai-working';
  if (document.getElementById(ID)) return true;
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  const pill = document.createElement('div');
  pill.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:999px;'
    + 'background:#1f2937;color:#fff;font:600 13px/1.2 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)';
  const dot = document.createElement('span');
  dot.style.cssText = 'width:9px;height:9px;border-radius:50%;background:#4c8df6;'
    + 'box-shadow:0 0 0 3px rgba(76,141,246,.3)';
  const text = document.createElement('span');
  text.textContent = 'IntegratedAI is working on this page';
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.textContent = '■ Stop';
  stop.style.cssText = 'border:0;border-radius:999px;padding:6px 12px;background:#fff;color:#1f2937;font:inherit;cursor:pointer';
  stop.addEventListener('click', () => {
    h.state().stopRequested = true;
    text.textContent = 'Stopping…';
    stop.disabled = true;
  });
  pill.append(dot, text, stop);
  root.append(pill);
  document.documentElement.append(host);
  return true;
}

/** Remove the badge (the turn is over). */
export function hideWorkingBadge(h) {
  document.getElementById('integratedai-working')?.remove();
  h.state().stopRequested = false;
  return true;
}

/** Was Stop clicked on the page? Reading it clears it. */
export function takeStopRequest(h) {
  const asked = h.state().stopRequested === true;
  h.state().stopRequested = false;
  return asked;
}

/** Remove the outline of a step that was not done (denied, or failed). */
export function clearHighlight() {
  document.getElementById('integratedai-highlight')?.remove();
  return true;
}

/** Undo the typed values / selections / checkboxes of an interact action (newest first). */
export function revertInteract(h, selected, { actionId }) {
  const entries = h.state().interact?.[actionId];
  if (!entries) throw new Error('Nothing to undo (the page was probably reloaded)');
  const fire = (target, type) => target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, composed: true }));
  const setNative = (target, prop, value) => {
    let proto = Object.getPrototypeOf(target);
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc && desc.set) { desc.set.call(target, value); return; }
      proto = Object.getPrototypeOf(proto);
    }
    target[prop] = value;
  };
  for (const entry of [...entries].reverse()) {
    if (!entry.el || !entry.el.isConnected) continue;
    if (entry.kind === 'value') {
      setNative(entry.el, 'value', entry.before);
      fire(entry.el, 'input');
      fire(entry.el, 'change');
    } else if (entry.kind === 'html') {
      entry.el.innerHTML = entry.before;
      fire(entry.el, 'input');
    } else {
      entry.el.click(); // toggle back / re-select the previous radio
    }
  }
  delete h.state().interact[actionId];
  return true;
}
