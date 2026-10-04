// @ts-check
/**
 * Scopes for persistent patches: decide which pages a saved patch applies to.
 *
 *   { type: 'origin',  value: 'https://example.com' }          every page on that origin
 *   { type: 'prefix',  value: 'https://example.com/docs/' }     URLs starting with this
 *   { type: 'pattern', value: 'https://*.example.com/app/*' }   simple glob, * = any characters
 *
 * Patches never apply to chrome://, chrome-extension:// or other non-web pages.
 */

/** @typedef {{ type: 'origin'|'prefix'|'pattern', value: string }} Scope */

/**
 * @param {Scope} scope
 * @param {string} url
 */
export function scopeMatches(scope, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') return false;

  switch (scope.type) {
    case 'origin':
      return parsed.origin === scope.value;
    case 'prefix':
      return url.startsWith(scope.value);
    case 'pattern':
      return globToRegExp(scope.value).test(url);
    default:
      return false;
  }
}

/**
 * Convert a glob like "https://*.example.com/*" to an anchored RegExp.
 * Only `*` is special; everything else matches literally.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * The default scope for a new patch saved on `url`: its origin.
 * @param {string} url
 * @returns {Scope | null}
 */
export function defaultScopeFor(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return { type: 'prefix', value: url.split(/[?#]/)[0] };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { type: 'origin', value: u.origin };
  } catch {
    return null;
  }
}

/** @param {Scope} scope */
export function describeScope(scope) {
  switch (scope.type) {
    case 'origin': return `all pages on ${scope.value}`;
    case 'prefix': return `URLs starting with ${scope.value}`;
    case 'pattern': return `URLs matching ${scope.value}`;
    default: return 'unknown scope';
  }
}
