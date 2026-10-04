// @ts-check
/**
 * A deliberately tiny JSON-Schema validator.
 *
 * It supports only the subset of JSON Schema used by our action schemas:
 *   type, properties, required, additionalProperties:false, items, enum, const, anyOf
 *
 * Why not ajv? This file is shared by the Chrome extension (which has no build
 * step and no npm dependencies) and the Node server. Both sides validate every
 * action, so a compromised or buggy server can't make the panel run something
 * malformed, and a misbehaving model can't make the server forward junk.
 *
 * Extra safety limits (not part of JSON Schema, applied to every value):
 *   - strings longer than LIMITS.maxString are rejected
 *   - arrays longer than LIMITS.maxArray are rejected
 */

export const LIMITS = {
  maxString: 50_000,
  maxArray: 200,
};

/**
 * @typedef {object} Schema
 * @property {string | string[]} [type]
 * @property {Record<string, Schema>} [properties]
 * @property {string[]} [required]
 * @property {boolean} [additionalProperties]
 * @property {Schema} [items]
 * @property {unknown[]} [enum]
 * @property {unknown} [const]
 * @property {Schema[]} [anyOf]
 * @property {string} [description]
 */

/**
 * Validate `value` against `schema`.
 * @param {Schema} schema
 * @param {unknown} value
 * @param {string} [path] used in error messages, e.g. "input.setStyles[0].value"
 * @returns {string[]} list of human-readable errors (empty = valid)
 */
export function validate(schema, value, path = 'value') {
  /** @type {string[]} */
  const errors = [];

  if (schema.anyOf) {
    const ok = schema.anyOf.some((sub) => validate(sub, value, path).length === 0);
    if (!ok) errors.push(`${path} does not match any allowed shape`);
    return errors;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
    return errors;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
    return errors;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push(`${path} must be of type ${types.join(' | ')}`);
      return errors;
    }
  }

  if (typeof value === 'string' && value.length > LIMITS.maxString) {
    errors.push(`${path} is too long (${value.length} > ${LIMITS.maxString} chars)`);
  }

  if (Array.isArray(value)) {
    if (value.length > LIMITS.maxArray) errors.push(`${path} has too many items`);
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
    }
  } else if (value !== null && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) errors.push(...validate(props[key], v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }

  return errors;
}

/**
 * @param {string} type
 * @param {unknown} value
 */
function matchesType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return false;
  }
}
