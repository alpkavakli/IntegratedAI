// @ts-check
/**
 * "About me": the user's CV (as text) and notes about themselves, for writing applications: cover letters,
 * answers to application questions, messages. Added on the options page (a PDF's text is read there, on this
 * computer). Kept in this browser (chrome.storage.local "profile") and sent to the AI only with a message the
 * user attaches it to: the "About me" chip, which the Write… menu switches on. Never part of an export (like the
 * API keys), and deleted with "Delete extension data".
 */

/** The CV and the notes are cut to these lengths (a two-page CV is about 6,000 characters). */
export const MAX_CV_CHARS = 20000;
export const MAX_NOTES_CHARS = 4000;

/**
 * @typedef {object} Profile
 * @property {string} cv        the CV as plain text
 * @property {string} notes     what else the AI should know (roles wanted, availability, tone)
 * @property {string} cvName    the uploaded file's name ('' when pasted)
 * @property {number} updatedAt
 */

/** @returns {Promise<Profile>} */
export async function loadProfile() {
  const { profile } = await chrome.storage.local.get('profile');
  return { cv: '', notes: '', cvName: '', updatedAt: 0, ...profile };
}

/** @param {Partial<Profile>} changes */
export async function saveProfile(changes) {
  const next = { ...(await loadProfile()), ...changes, updatedAt: Date.now() };
  next.cv = String(next.cv ?? '').slice(0, MAX_CV_CHARS);
  next.notes = String(next.notes ?? '').slice(0, MAX_NOTES_CHARS);
  await chrome.storage.local.set({ profile: next });
  return next;
}

export async function clearProfile() {
  await chrome.storage.local.remove('profile');
}

/** Is there anything to attach? @param {Pick<Profile, 'cv' | 'notes'>} profile */
export const hasProfile = (profile) => Boolean(profile.cv.trim() || profile.notes.trim());

/**
 * What goes to the AI with a message (context.aboutMe; shown to it as an <about_me> block), or null when nothing
 * is saved.
 * @param {Pick<Profile, 'cv' | 'notes'>} profile
 */
export function aboutMe(profile) {
  if (!hasProfile(profile)) return null;
  return {
    ...(profile.cv.trim() ? { cv: profile.cv.trim().slice(0, MAX_CV_CHARS) } : {}),
    ...(profile.notes.trim() ? { notes: profile.notes.trim().slice(0, MAX_NOTES_CHARS) } : {}),
  };
}

/** @param {(profile: Profile) => void} callback */
export function onProfileChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.profile) loadProfile().then(callback);
  });
}
