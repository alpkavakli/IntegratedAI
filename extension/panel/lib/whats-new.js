// @ts-check
/**
 * "What's new": after Chrome updates the extension (the service worker notes it as storage.local "updated"), the
 * panel or the card shows one line about the new version the first time it opens, once. Only versions listed here
 * get a line (a bug-fix update says nothing); the setup page's "What's new" section has the longer list.
 */

import { t } from '../../shared/i18n.js';

/** @type {Record<string, () => string>} */
const LINES = {
  '0.3.0': () => t('whatsNew030', 'Updated to 0.3: cover letters and answers from your CV, search in your ChatGPT history, watching videos, and whole comment sections read before a summary.'),
};

/**
 * The line to show now, or '' (nothing new, a fresh install, or already shown). Marks it as shown.
 * @returns {Promise<string>}
 */
export async function whatsNewLine() {
  const version = chrome.runtime.getManifest().version;
  const { updated, whatsNewSeen } = await chrome.storage.local.get(['updated', 'whatsNewSeen']);
  const line = LINES[version];
  if (!line || updated?.to !== version || whatsNewSeen === version) return '';
  await chrome.storage.local.set({ whatsNewSeen: version });
  return line();
}
