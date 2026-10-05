// @ts-nocheck
/**
 * The `interact` action, inside the inspected page: click, type, select, check, submit,
 * scroll, press a key, wait.
 *
 * These run via callInPage (see inspected.js), so like page-scripts.js each
 * exported function must be self-contained (no imports, no module variables)
 * and gets (h = pageHelpers(), selected = $0, args).
 *
 * Why not just set attributes? Frameworks (React, Vue, Angular, MUI) keep their
 * own state and only update it from events. So we:
 *   - click with a full pointer/mouse sequence and element.click() (which also
 *     performs the default action: toggling a radio, following a link, …)
 *   - set input values through the native value setter, then fire input/change
 *     (React ignores `el.value = x` without this)
 *
 * The panel runs one step at a time and retries a step for up to 5 s while its
 * element doesn't exist yet (e.g. a menu that opens after the previous click).
 */

/**
 * Run one step. Returns { found: false } if the element isn't there (yet).
 *
 * With dry: true nothing happens: the step's target is found, outlined on the page with a
 * label (so the user can follow the AI working), and described, including whether the step
 * is risky (the agent modes ask before those).
 * @returns {{ found: false } | { found: true, did: string, undoable: boolean }
 *   | { found: true, what: string, risky: string }}  risky: why it is, or ''
 */
export function interactStep(h, selected, { actionId, step, dry = false }) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const textOf = (el) => norm(
    el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title')
    || el.getAttribute('placeholder') || (el.labels && el.labels[0] && el.labels[0].innerText) || '',
  );
  const fire = (target, type, Ctor = Event, init = {}) =>
    target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));

  /** A real-looking click: pointer + mouse events, focus, then click() for the default action. */
  const realClick = (target) => {
    const r = target.getBoundingClientRect();
    const pos = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    const pointer = { ...pos, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    fire(target, 'pointerover', PointerEvent, pointer);
    fire(target, 'mouseover', MouseEvent, pos);
    fire(target, 'pointerdown', PointerEvent, pointer);
    fire(target, 'mousedown', MouseEvent, pos);
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    fire(target, 'pointerup', PointerEvent, pointer);
    fire(target, 'mouseup', MouseEvent, pos);
    target.click();
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

  function find() {
    let scope = [document.body];
    if (step.selector) {
      let list;
      try { list = [...document.querySelectorAll(step.selector)]; } catch { throw new Error(`Invalid selector: ${step.selector}`); }
      if (!step.text) return list.find(visible) || list[0] || null;
      scope = list;
    }
    const want = norm(step.text);
    const CANDIDATES = 'button, a, label, input, select, textarea, option, summary, [role], [tabindex], li, td, th, span, div, p, h1, h2, h3, h4';
    const candidates = [];
    for (const root of scope) {
      if (root !== document.body) candidates.push(root);
      candidates.push(...root.querySelectorAll(CANDIDATES));
    }
    const usable = candidates.filter((el) => el !== document.body && el !== document.documentElement && visible(el));
    let pool = usable.filter((el) => textOf(el) === want);
    if (!pool.length) pool = usable.filter((el) => textOf(el).startsWith(want));
    if (!pool.length && want.length > 2) pool = usable.filter((el) => textOf(el).includes(want));
    // The most specific match: one that doesn't contain another match.
    return pool.find((el) => !pool.some((other) => other !== el && el.contains(other))) || null;
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
    setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.remove(), 400); }, 1600);
  };

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

  // Steps that don't need a target: scroll the page, press a key on what has focus, pause.
  const targetless = !step.selector && !step.text;
  if (targetless && ['scroll', 'press', 'wait'].includes(step.action)) {
    if (dry) {
      const what = step.action === 'scroll' ? `scroll the page ${step.value}` : step.action === 'press' ? `press ${step.value}` : `wait ${step.value} s`;
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
    const what = `${step.action} ${h.label(el)}${step.text ? ` "${step.text}"` : ''}${step.action === 'type' || step.action === 'select' ? ` → "${String(step.value).slice(0, 40)}"` : ''}`;
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
  const name = `${h.label(el)}${step.text ? ` "${step.text}"` : ''}`;
  const field = (node) => (node.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
    ? node
    : node.control || node.querySelector('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || node);

  switch (step.action) {
    case 'click':
      realClick(el);
      return { found: true, did: `clicked ${name}`, undoable: false };

    case 'type': {
      const target = field(el);
      if (target.isContentEditable) {
        undo.push({ el: target, kind: 'text', before: target.textContent });
        target.focus();
        target.textContent = step.value;
        fire(target, 'input', InputEvent, { inputType: 'insertText', data: step.value });
      } else if ('value' in target) {
        undo.push({ el: target, kind: 'value', before: target.value });
        target.focus();
        setNative(target, 'value', step.value);
        fire(target, 'input', InputEvent, { inputType: 'insertText', data: step.value });
        fire(target, 'change');
      } else {
        throw new Error(`${name} is not a text field`);
      }
      return { found: true, did: `typed "${step.value.slice(0, 60)}" into ${name}`, undoable: true };
    }

    case 'select': {
      const target = field(el);
      if (target.tagName !== 'SELECT') throw new Error(`${name} is not a <select>; open a custom dropdown with click steps instead`);
      const want = norm(step.value);
      const option = [...target.options].find((o) => norm(o.value) === want || norm(o.text) === want)
        || [...target.options].find((o) => norm(o.text).includes(want));
      if (!option) throw new Error(`No option "${step.value}" in ${name}`);
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
      if (checked === want) return { found: true, did: `${name} was already ${want ? 'checked' : 'unchecked'}`, undoable: true };
      if (isNative && target.type === 'radio') {
        if (!want) throw new Error('A radio button cannot be unchecked; check another option instead');
        const group = target.name ? [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(target.name)}"]`)] : [];
        undo.push({ el: group.find((r) => r.checked) || null, kind: 'radio' });
      } else {
        undo.push({ el: isNative ? target : el, kind: 'toggle' });
      }
      // Click the visible part: hidden native inputs (common in UI kits) don't take real clicks.
      realClick(isNative && !visible(target) ? (target.labels && target.labels[0]) || el : (isNative ? target : el));
      return { found: true, did: `${want ? 'checked' : 'unchecked'} ${name}`, undoable: true };
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
    } else if (entry.kind === 'text') {
      entry.el.textContent = entry.before;
      fire(entry.el, 'input');
    } else {
      entry.el.click(); // toggle back / re-select the previous radio
    }
  }
  delete h.state().interact[actionId];
  return true;
}
