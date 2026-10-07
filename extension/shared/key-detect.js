// @ts-check
/**
 * Which provider an API key belongs to, from its prefix, so the setup page can pick the provider for the
 * user when they paste a key. Only prefixes that belong to one provider count: plain "sk-…" keys are used
 * by OpenAI (older keys), DeepSeek, Kimi, Qwen and others, so those give null (the user's choice stands).
 * The key is only looked at here; it is never sent anywhere to find out.
 */

/** [prefix, provider id], most specific first. */
const PREFIXES = [
  ['sk-ant-', 'anthropic'],
  ['sk-or-', 'openrouter'],
  ['sk-proj-', 'openai'],
  ['sk-svcacct-', 'openai'],
  ['sk-admin-', 'openai'],
  ['AIza', 'gemini'],
];

/**
 * @param {string} key
 * @returns {string | null} the provider id (as in the setup page), or null when the key doesn't say
 */
export function providerForKey(key) {
  const k = key.trim();
  if (k.length < 20) return null; // still typing, or not a key
  return PREFIXES.find(([prefix]) => k.startsWith(prefix))?.[1] ?? null;
}
