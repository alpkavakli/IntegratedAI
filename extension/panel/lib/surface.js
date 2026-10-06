// @ts-check
/**
 * Where this panel runs. The same panel (panel.html) runs in two places:
 *
 *   DevTools  the AI tab in DevTools: every tool (devtools/devtools.js creates it)
 *   card      the basic version on the page itself, opened from the toolbar button
 *             (content/card-host.js puts panel.html?card=1&tabId=… in a frame): reading the
 *             page, screenshots, CSS changes and site memory; the rest is "Continue in DevTools"
 *
 * In the card there is no chrome.devtools: page code runs through chrome.scripting
 * (inspected.js), and an element is chosen with Pick element instead of the Elements panel.
 */

// (globalThis: this module is also loaded by the unit tests, in Node.)
const params = new URLSearchParams(globalThis.location?.search ?? '');

/** The panel is the card on the page (not the DevTools tab). */
export const IN_CARD = params.has('card');

/** The tab this panel works on. */
export const TAB_ID = IN_CARD ? Number(params.get('tabId')) : globalThis.chrome?.devtools?.inspectedWindow.tabId ?? -1;

export { CARD_ACTIONS } from '../../shared/actions.js';
