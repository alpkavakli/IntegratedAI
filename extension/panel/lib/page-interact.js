// @ts-nocheck
/**
 * The `interact` action, inside the inspected page: click, type, select, check, submit.
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
 * @returns {{ found: false } | { found: true, did: string, undoable: boolean }}
 */
export function interactStep(h, selected, { actionId, step }) {
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

  const el = find();
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });

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
