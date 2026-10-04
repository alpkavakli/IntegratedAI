// @ts-check
/**
 * Sites and page groups: how memory and conversation history are organised.
 *
 *   site        the host without "www.", e.g. "webnovel.com" (local files: "local-files")
 *   page group  a path pattern for one kind of page on a site, e.g.
 *               "/book/*\/*"  = every chapter page, however long and dynamic the URL is.
 *
 * Patterns: segments separated by "/". "*" matches exactly one segment, a final
 * "**" matches any remaining segments (including none). The query string and
 * hash are ignored.
 *
 * Without a named group, autoPattern() guesses one by replacing segments that
 * look like IDs (numbers, hashes, slugs containing long numbers) with "*".
 * The AI can then name/merge groups with the define_page_group action.
 */

/**
 * @param {string} url
 * @returns {string | null} site key, or null for pages that have no memory (chrome://, about:, …)
 */
export function siteKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'local-files';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** @param {string} url */
export function pathOf(url) {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return '/';
  }
}

/**
 * Does this path segment look like an ID rather than a fixed name?
 * @param {string} segment
 */
export function isDynamicSegment(segment) {
  let s = segment;
  try { s = decodeURIComponent(segment); } catch { /* keep raw */ }
  if (/^\d+$/.test(s)) return true;                                   // 12345
  if (/^[0-9a-f-]{32,36}$/i.test(s)) return true;                      // UUID
  if (/^[0-9a-f]{8,}$/i.test(s) && /\d/.test(s)) return true;          // hex hash
  if (/\d{4,}/.test(s)) return true;                                   // lord-of-mysteries_11022733705139605
  if (s.length > 40) return true;                                      // long article slugs
  if (/^[A-Za-z0-9_-]{16,}$/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return true; // base64-ish ids
  return false;
}

/**
 * Best guess at a page group pattern for a path.
 * "/book/lord-of-mysteries_1102273/chapter-1_293845" → "/book/*\/*"
 * @param {string} pathname
 */
export function autoPattern(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length) return '/';
  return `/${segments.map((s) => (isDynamicSegment(s) ? '*' : s)).join('/')}`;
}

/**
 * @param {string} pattern
 * @param {string} pathname
 */
export function matchPattern(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '**' && i === p.length - 1) return true;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

/** Is this a well-formed pattern? @param {string} pattern */
export function isValidPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('/') || pattern.length > 200) return false;
  const segments = pattern.split('/').filter(Boolean);
  return segments.every((seg, i) => seg !== '**' || i === segments.length - 1) && !/[\s?#]/.test(pattern);
}

/**
 * More specific patterns win: more fixed segments, then fewer wildcards.
 * @param {string} pattern
 */
function specificity(pattern) {
  const segments = pattern.split('/').filter(Boolean);
  const fixed = segments.filter((s) => s !== '*' && s !== '**').length;
  return fixed * 100 + segments.length * 10 - (pattern.includes('**') ? 5 : 0);
}

/**
 * @typedef {{ id: string, name: string, pattern: string }} PageGroup
 *
 * The page group for a path: the most specific named group that matches,
 * otherwise an unnamed automatic one.
 * @param {PageGroup[]} groups
 * @param {string} pathname
 * @returns {{ id?: string, name: string | null, pattern: string, auto: boolean }}
 */
export function resolveGroup(groups, pathname) {
  const matching = groups.filter((g) => matchPattern(g.pattern, pathname));
  if (matching.length) {
    const best = matching.sort((a, b) => specificity(b.pattern) - specificity(a.pattern))[0];
    return { id: best.id, name: best.name, pattern: best.pattern, auto: false };
  }
  return { name: null, pattern: autoPattern(pathname), auto: true };
}
