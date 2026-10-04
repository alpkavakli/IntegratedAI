// @ts-check
/**
 * The action catalog: every thing the model is allowed to ask for.
 *
 * This file is the single source of truth shared by the server and the
 * extension. The server turns these into provider "tools" (Anthropic API) or a
 * JSON response schema (Claude Code CLI). The extension uses the same schemas to
 * re-validate every action before running it.
 *
 * Two kinds of actions:
 *   - readOnly: true   → inspections. They only read from the page and can run
 *                        automatically (the user can turn on "ask first").
 *   - readOnly: false  → mutations. They are NEVER run automatically. The panel
 *                        shows them as a card and the user must click Apply.
 *
 * Schemas use only features supported by Anthropic "strict" tool schemas:
 * every object has additionalProperties:false, no min/max constraints.
 * (Length limits are enforced separately by validate.js.)
 */

import { validate } from './validate.js';

/** @typedef {import('./validate.js').Schema} Schema */

/**
 * @typedef {object} ActionDef
 * @property {string} label          Short human label for the UI
 * @property {boolean} readOnly      true = inspection, false = mutation
 * @property {'none'|'low'|'medium'|'high'} risk
 * @property {string} description    Shown to the model
 * @property {Schema} inputSchema
 * @property {'executeJs'} [requiresSetting]  Only offered when that setting is on
 */

const selectorProp = {
  type: 'string',
  description:
    'CSS selector of the target element. Omit to target the element currently selected in the Elements panel ($0); its selector is given in the page context.',
};

/** @type {Record<string, ActionDef>} */
export const ACTIONS = {
  // ---------------------------------------------------------------- read-only
  inspect_element: {
    label: 'Inspect element',
    readOnly: true,
    risk: 'none',
    description:
      'Read more details about an element than the default page context provides: all computed styles, matching CSS rules, ancestors (useful for overflow/layout bugs), children, or a larger HTML excerpt.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: selectorProp,
        include: {
          type: 'array',
          description: 'Which extra details to return.',
          items: { type: 'string', enum: ['computed_all', 'rules', 'ancestors', 'children', 'html'] },
        },
      },
      required: ['include'],
      additionalProperties: false,
    },
  },

  inspect_console: {
    label: 'Read console',
    readOnly: true,
    risk: 'none',
    description: 'Read recent console messages and uncaught errors captured on the page.',
    inputSchema: {
      type: 'object',
      properties: {
        levels: { type: 'array', items: { type: 'string', enum: ['error', 'warn', 'info', 'log'] } },
        contains: { type: 'string', description: 'Only messages containing this text.' },
        limit: { type: 'integer', description: 'Max entries (default 20).' },
      },
      additionalProperties: false,
    },
  },

  inspect_network: {
    label: 'Read network log',
    readOnly: true,
    risk: 'low',
    description:
      'List network requests recorded while DevTools has been open (method, URL, status, type, size, timing). Sensitive headers (cookies, authorization, API keys) are always redacted. Response bodies are not included.',
    inputSchema: {
      type: 'object',
      properties: {
        urlContains: { type: 'string' },
        onlyFailed: { type: 'boolean', description: 'Only status >= 400 or network failures.' },
        includeHeaders: { type: 'boolean', description: 'Include (redacted) request/response headers.' },
        limit: { type: 'integer', description: 'Max entries (default 30).' },
      },
      additionalProperties: false,
    },
  },

  inspect_resources: {
    label: 'Read page resources',
    readOnly: true,
    risk: 'low',
    description:
      'List resources loaded by the page (documents, stylesheets, scripts, …) or read the text content of one resource (truncated), e.g. to see the original CSS source.',
    inputSchema: {
      type: 'object',
      properties: {
        urlContains: { type: 'string' },
        type: { type: 'string', enum: ['document', 'stylesheet', 'script', 'image', 'font', 'other'] },
        readContentOf: { type: 'string', description: 'Exact URL of a resource whose content should be returned.' },
      },
      additionalProperties: false,
    },
  },

  // ---------------------------------------------------------------- mutations
  inject_css: {
    label: 'Inject CSS',
    readOnly: false,
    risk: 'low',
    description:
      'Propose a CSS stylesheet to add to the page. PREFERRED way to change appearance. Fully undoable and can be saved by the user as a persistent per-site patch. Use specific selectors (e.g. the selected element\'s selector from the context) so the change does not leak to unrelated elements.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'One short sentence: what this change does.' },
        css: { type: 'string', description: 'Plain CSS rules (no <style> tags).' },
      },
      required: ['description', 'css'],
      additionalProperties: false,
    },
  },

  modify_element: {
    label: 'Modify element',
    readOnly: false,
    risk: 'low',
    description:
      'Propose safe changes to ONE element: inline styles, attributes, classes or plain text. Fully undoable. Use when CSS alone is not enough (e.g. text or attribute changes). Event-handler attributes (on*) and javascript: URLs are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'One short sentence: what this change does.' },
        selector: selectorProp,
        setStyles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              property: { type: 'string', description: 'CSS property in kebab-case, e.g. "background-color".' },
              value: { type: 'string' },
              important: { type: 'boolean' },
            },
            required: ['property', 'value'],
            additionalProperties: false,
          },
        },
        removeStyles: { type: 'array', items: { type: 'string' } },
        setAttributes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
            additionalProperties: false,
          },
        },
        removeAttributes: { type: 'array', items: { type: 'string' } },
        addClasses: { type: 'array', items: { type: 'string' } },
        removeClasses: { type: 'array', items: { type: 'string' } },
        textContent: { type: 'string', description: 'Replace the element\'s text (plain text, not HTML).' },
      },
      required: ['description'],
      additionalProperties: false,
    },
  },

  execute_js: {
    label: 'Execute JavaScript',
    readOnly: false,
    risk: 'high',
    requiresSetting: 'executeJs',
    description:
      'LAST RESORT. Propose JavaScript to run in the page. Only use when inject_css and modify_element cannot do the job. `code` is a function body (you may use `return` to report a JSON-serializable result). Provide `undoCode` that reverses the effect whenever possible; say in `description` if it cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'One short sentence: what this code does.' },
        code: { type: 'string' },
        undoCode: { type: 'string', description: 'Function body that reverses `code`. Omit if impossible.' },
      },
      required: ['description', 'code'],
      additionalProperties: false,
    },
  },
};

export const ACTION_NAMES = /** @type {string[]} */ (Object.keys(ACTIONS));

/** @param {string} name */
export function isKnownAction(name) {
  return Object.hasOwn(ACTIONS, name);
}

/** @param {string} name */
export function isReadOnly(name) {
  return isKnownAction(name) && ACTIONS[name].readOnly;
}

/**
 * Names of the actions the model may use, given the user's settings.
 * @param {{ executeJs?: boolean }} settings
 */
export function enabledActionNames(settings) {
  return ACTION_NAMES.filter((name) => {
    const req = ACTIONS[name].requiresSetting;
    return !req || settings[req] === true;
  });
}

// Attributes that could run script or navigate to script. modify_element must not set these.
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster']);

/**
 * Full validation of one action: schema + safety rules.
 * Used by BOTH the server (before showing the proposal) and the panel (before executing).
 * @param {string} name
 * @param {unknown} input
 * @param {{ executeJs?: boolean }} [settings]  when given, also checks the action is enabled
 * @returns {string[]} errors (empty = valid)
 */
export function validateAction(name, input, settings) {
  if (!isKnownAction(name)) return [`Unknown action "${name}"`];
  const def = ACTIONS[name];
  if (settings && def.requiresSetting && settings[def.requiresSetting] !== true) {
    return [`Action "${name}" is disabled in the extension settings`];
  }

  const errors = validate(def.inputSchema, input, 'input');
  if (errors.length) return errors;

  const i = /** @type {any} */ (input);
  if (name === 'modify_element') {
    const changeKeys = ['setStyles', 'removeStyles', 'setAttributes', 'removeAttributes', 'addClasses', 'removeClasses', 'textContent'];
    if (!changeKeys.some((k) => i[k] !== undefined)) errors.push('modify_element needs at least one change');
    for (const attr of [...(i.setAttributes ?? [])]) {
      const n = String(attr.name).toLowerCase().trim();
      if (n.startsWith('on')) errors.push(`Setting event-handler attribute "${attr.name}" is not allowed`);
      if (n === 'srcdoc') errors.push('Setting "srcdoc" is not allowed');
      if (URL_ATTRS.has(n) && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
        errors.push(`Script URL in "${attr.name}" is not allowed`);
      }
      if (!/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(attr.name)) errors.push(`Invalid attribute name "${attr.name}"`);
    }
  }
  if (name === 'inject_css' && /<\/?style/i.test(i.css)) {
    errors.push('css must be plain CSS without <style> tags');
  }
  return errors;
}

/**
 * JSON Schema for providers that can't do native tool calls (Claude Code CLI):
 * the model must answer with { reply, actions: [{ type, input }] }.
 * @param {string[]} names enabled action names
 * @returns {Schema}
 */
export function envelopeSchema(names) {
  return {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Your message to the user (Markdown allowed).' },
      actions: {
        type: 'array',
        description: 'Inspections to run or changes to propose. Empty array if none.',
        items: {
          anyOf: names.map((name) => ({
            type: 'object',
            properties: {
              type: { const: name, description: ACTIONS[name].description },
              input: ACTIONS[name].inputSchema,
            },
            required: ['type', 'input'],
            additionalProperties: false,
          })),
        },
      },
    },
    required: ['reply', 'actions'],
    additionalProperties: false,
  };
}
