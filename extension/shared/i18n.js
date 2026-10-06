// @ts-check
/**
 * Interface text in the browser's language, with Chrome's i18n (extension/_locales/<lang>/messages.json; English
 * is the default). Only what people read is translated: text for the AI (tool results, errors it gets back)
 * stays English, which models handle best (and they answer in the user's language anyway).
 *
 *   t(key, "New")                    a message, or the English given here if it has none
 *   t(key, "Saved as $1.", name)       $1…$9: values put into the message
 *   localize(document)                          fills elements marked in the HTML:
 *     data-i18n="key"            the text (the element's English text is the fallback)
 *     data-i18n-html="key"       markup (<strong>, <kbd>, <code>) from our own messages
 *     data-i18n-title / -placeholder / -aria-label="key"   those attributes
 *
 * Works without chrome.i18n too (in the unit tests): then everything is English.
 */

/**
 * @param {string} key
 * @param {string} english
 * @param {...(string | number)} values
 */
export function t(key, english, ...values) {
  let message = '';
  try {
    message = globalThis.chrome?.i18n?.getMessage?.(key, values.map(String)) ?? '';
  } catch { /* not in an extension page */ }
  return message || values.reduce((/** @type {string} */ text, v, i) => text.replaceAll(`$${i + 1}`, String(v)), english);
}

/** @param {ParentNode} root */
export function localize(root = document) {
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-i18n]'))) {
    el.textContent = t(/** @type {string} */ (el.dataset.i18n), el.textContent ?? '');
  }
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-i18n-html]'))) {
    // Only our own packaged messages (never page or AI text), so markup is safe here.
    const html = t(/** @type {string} */ (el.dataset.i18nHtml), '');
    if (html) el.innerHTML = html;
  }
  for (const [data, attr] of [['i18nTitle', 'title'], ['i18nPlaceholder', 'placeholder'], ['i18nAriaLabel', 'aria-label']]) {
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(`[data-${attr === 'title' ? 'i18n-title' : attr === 'placeholder' ? 'i18n-placeholder' : 'i18n-aria-label'}]`))) {
      el.setAttribute(attr, t(/** @type {string} */ (el.dataset[data]), el.getAttribute(attr) ?? ''));
    }
  }
}
