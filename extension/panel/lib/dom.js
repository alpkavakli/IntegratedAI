// @ts-check
/**
 * h('button', { class: 'primary', onclick: fn, disabled: true }, 'Apply')
 *
 * Tiny helper to build DOM without innerHTML. Strings become text nodes, so
 * untrusted text (page content, model output) can never inject HTML.
 *
 * Props: `class`, `on<event>` listeners, boolean attributes (true/false), and
 * the properties value/checked/textContent; anything else becomes an attribute.
 *
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...(Node | string | number | null | undefined | false | (Node | string)[])} children
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value' || key === 'checked' || key === 'textContent') /** @type {any} */ (el)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  setChildren(el, ...children);
  return el;
}

/**
 * Replace an element's children, with the same rules as h(): arrays are
 * flattened, null/undefined/false are skipped, strings become text nodes.
 * (Use instead of el.replaceChildren(), which would print "null".)
 * @param {Element} el
 * @param {...(Node | string | number | null | undefined | false | (Node | string | null | undefined | false)[])} children
 */
export function setChildren(el, ...children) {
  el.replaceChildren();
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}
