// @ts-check
/**
 * USD prices per million tokens, used to estimate cost for providers that only
 * report token counts. Update when prices change. Unknown models → cost null.
 *
 * cacheWrite is the 5-minute cache write price (1.25 × input).
 */
export const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/**
 * @param {string} model
 * @param {{ input: number, output: number, cacheRead?: number, cacheWrite?: number }} tokens
 * @returns {number | null}
 */
export function estimateCost(model, tokens) {
  const p = PRICES[/** @type {keyof typeof PRICES} */ (model)];
  if (!p) return null;
  return (
    (tokens.input * p.input +
      tokens.output * p.output +
      (tokens.cacheRead ?? 0) * p.cacheRead +
      (tokens.cacheWrite ?? 0) * p.cacheWrite) /
    1_000_000
  );
}
