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
 *   - readOnly: false  → mutations. In "Suggest" mode they are NEVER run automatically:
 *                        the panel shows them as a card and the user must click Apply.
 *
 * Page actions (pageAction: true: interact, navigate) operate the page like the user
 * does. In the agent modes the user can choose per conversation (AGENT_MODES), they
 * run during the turn (after the panel asks, if the mode says so) and their result
 * goes back to the model, so it can work through a task step by step.
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
 * @property {boolean} [serverSide]  Runs on the server (site memory), never touches the page,
 *                                   needs no approval; shown in the chat and undoable in the Memory tab
 * @property {boolean} [pageAction]  Operates the page like the user (clicks, typing, going to pages);
 *                                   runs during the turn in the agent modes
 */

/**
 * How the AI may operate the page, chosen per conversation (like Claude Code's permission modes):
 *   suggest → every change is a proposal card the user applies (default)
 *   ask     → page actions run during the turn; the panel asks before each step
 *   auto    → page actions run on their own; the panel still asks before risky steps
 *             (submitting, sending, paying, deleting, password fields, another site)
 *   full    → page actions never ask (switched on explicitly per conversation)
 * Style changes, element edits and scripts stay proposals in every mode.
 */
export const AGENT_MODES = /** @type {const} */ (['suggest', 'ask', 'auto', 'full']);

const selectorProp = {
  type: 'string',
  description:
    'CSS selector of the target element. Omit to target the element currently selected in the Elements panel ($0); its selector is given in the page context.',
};

const refProp = {
  type: 'string',
  description: 'Or: the element\'s ref ("e" and a number) as returned by find_elements or page_outline. Always means exactly that element (more reliable than a selector); valid until the page reloads.',
};

const frameProp = {
  type: 'string',
  description: 'URL of an iframe to work in, as listed under "frames" by page_outline. Omit for the page itself.',
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
        ref: refProp,
        frame: frameProp,
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

  find_elements: {
    label: 'Find elements',
    readOnly: true,
    risk: 'none',
    description:
      'Search the page for elements by CSS selector and/or visible text, e.g. to locate the nav bar, a footer or all buttons labelled "Sign in". Returns, for each match (visible ones first), a ref to target it in interact steps, a plain-words name, a selector and its text. With neither selector nor text, returns the page landmarks (header, nav, main, footer, …). Use this instead of guessing selectors. Also searches open shadow roots.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to search for.' },
        text: { type: 'string', description: 'Visible text the element contains (case-insensitive).' },
        limit: { type: 'integer', description: 'Max results (default 15).' },
        frame: frameProp,
      },
      additionalProperties: false,
    },
  },

  page_outline: {
    label: 'Look at the page',
    readOnly: true,
    risk: 'none',
    description:
      'What is on screen right now, the way a person scanning the page sees it: the buttons, links and fields (each with a ref to use in interact steps, its state and where links go), the focused element, an open dialog, headings, iframes, and the visible text (short). ' +
      'Use it to get your bearings on a page; interact and navigate return it automatically after each step. all: true lists the whole page instead of only what is on screen.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'The whole page, not only what is on screen.' },
        limit: { type: 'integer', description: 'Max elements listed (default 60).' },
        frame: frameProp,
      },
      additionalProperties: false,
    },
  },

  read_text: {
    label: 'Read text',
    readOnly: true,
    risk: 'none',
    description:
      'Read the text of the page or of one element, as a person sees it: one line per block, "#" before headings, "- " before list items, form fields with their values, hidden parts left out. ' +
      'Use it to read articles, messages, search results, tables and file contents (also the contents of text areas, like a code viewer\'s). Returns about 12,000 characters at a time; call again with nextOffset for more.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the part to read. Omit (and ref) for the whole page.' },
        ref: refProp,
        links: { type: 'boolean', description: 'Add each link\'s address after its text.' },
        offset: { type: 'integer', description: 'Start at this character (nextOffset from the previous call).' },
        frame: frameProp,
      },
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

  screenshot: {
    label: 'Screenshot',
    readOnly: true,
    risk: 'low',
    description:
      'See how part of the page actually looks: returns an image of an element (or of the visible page). Use it to check colours, contrast, spacing and layout, to find areas a theme missed, and to verify a change after the user applied it. Only on-screen content can be captured: an element outside the viewport is scrolled into view and the scroll position is restored afterwards; a part taller than the viewport is cut off. Prefer find_elements / inspect_element for selectors and CSS values.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to capture. Omit to capture the selected element ($0), or the visible page if nothing is selected.' },
        ref: refProp,
        fullViewport: { type: 'boolean', description: 'Capture everything visible in the tab instead of one element.' },
      },
      additionalProperties: false,
    },
  },

  // ---------------------------------------------------------------- site memory (server-side)
  remember: {
    label: 'Remember',
    readOnly: false,
    serverSide: true,
    risk: 'none',
    description:
      'Save a short note about this site so future conversations start out knowing it: stable selectors (e.g. "nav bar: nav.g_nav", "chapter text: .cha-words p"), site quirks, and the user\'s preferences (e.g. "prefers dark themes, bg #121212"). scope "site" = all pages of the site; "page_group" = only pages like this one. Do not save secrets, personal data, or one-off details.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'One fact, max ~200 characters.' },
        scope: { type: 'string', enum: ['site', 'page_group'] },
      },
      required: ['note', 'scope'],
      additionalProperties: false,
    },
  },

  forget: {
    label: 'Forget',
    readOnly: false,
    serverSide: true,
    risk: 'none',
    description: 'Delete a site-memory note that is wrong or outdated (by its id from <site_memory>). To correct a note, forget it and remember the new version.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },

  define_page_group: {
    label: 'Name page type',
    readOnly: false,
    serverSide: true,
    risk: 'none',
    description:
      'Name the type of page the user is on and the URL path pattern for all pages of that type, e.g. { name: "Chapter reader", pattern: "/book/*/*" } or { name: "Search results", pattern: "/search" }. "*" = one path segment, a final "**" = any number. The pattern must match the current page. Use when <site_memory> shows an unnamed or wrong pageGroup; reusing an existing name updates that group.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short human name, e.g. "Chapter reader".' },
        pattern: { type: 'string', description: 'Path pattern starting with "/".' },
      },
      required: ['name', 'pattern'],
      additionalProperties: false,
    },
  },

  // ---------------------------------------------------------------- mutations
  inject_css: {
    label: 'Inject CSS',
    readOnly: false,
    risk: 'low',
    description:
      'Propose a CSS stylesheet to add to the page. PREFERRED way to change appearance. Fully undoable and can be saved by the user as a persistent per-site patch. Use specific selectors (e.g. the selected element\'s selector from the context) so the change does not leak to unrelated elements. ' +
      'Add `toggle` when the user wants to switch the change on and off from the page itself (theme switch, "show/hide sidebar", reading mode): once the user saves the patch, the extension adds a real button to the page that turns this CSS on/off and remembers the choice. No JavaScript is needed for that.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'One short sentence: what this change does.' },
        css: { type: 'string', description: 'Plain CSS rules (no <style> tags). Applied only while the toggle is on.' },
        toggle: {
          type: 'object',
          description: 'Optional on/off button added to the page for this CSS.',
          properties: {
            label: { type: 'string', description: 'Button text while the CSS is OFF, e.g. "🌙" or "Dark mode". Keep it short.' },
            activeLabel: { type: 'string', description: 'Button text while the CSS is ON, e.g. "☀️". Defaults to label.' },
            placeSelector: { type: 'string', description: 'Element to put the button in/next to (find it with find_elements). Omit for a floating corner button.' },
            position: { type: 'string', enum: ['append', 'prepend', 'before', 'after'], description: 'Where relative to placeSelector (default append = last child).' },
          },
          required: ['label'],
          additionalProperties: false,
        },
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

  interact: {
    label: 'Interact with the page',
    readOnly: false,
    risk: 'medium',
    pageAction: true,
    description:
      'Click, type, choose options, tick boxes, hover, scroll and press keys on the page, like the user would: select a radio answer, fill in a form, pick from a dropdown, press a button, submit, scroll a list. ' +
      'Uses real browser events, so React/Vue/Angular/MUI apps and rich text editors register the change (unlike modify_element); no JavaScript needed. ' +
      'Steps run in order with a short pause, and each waits up to 5 s for its element (so a dropdown can open first). After a step the page is given a moment to finish loading or re-rendering, so no wait steps are needed after clicks. ' +
      'Target each step by ref (from find_elements or page_outline; most reliable), CSS selector, or visible text. ' +
      'Typed values and checkbox/select changes can be undone; clicks and submits cannot.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'One short sentence: what these steps do.' },
        frame: frameProp,
        steps: {
          type: 'array',
          description: 'Up to 25 steps, run in order.',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['click', 'hover', 'type', 'select', 'check', 'uncheck', 'submit', 'scroll', 'press', 'wait'],
                description: 'click: click the element. hover: point the mouse at it (opens hover menus and tooltips). type: replace the text of an input/textarea/contenteditable with value. select: choose the <select> option whose value or visible text is value. check/uncheck: set a checkbox or radio. submit: submit the form containing the element. ' +
                  'scroll: scroll the element\'s scrollable area (or the page, without a target) by value "down", "up", "top" or "bottom"; without value, scroll the element into view. ' +
                  'press: press the key in value ("Enter", "Escape", "Tab", "ArrowDown", …) on the element (or on whatever has focus). ' +
                  'wait: wait until the element appears (up to 10 s), or without a target for value seconds (max 10).',
              },
              ref: { type: 'string', description: 'The element\'s ref, exactly as find_elements or page_outline returned it.' },
              selector: { type: 'string', description: 'Or: CSS selector of the element.' },
              text: { type: 'string', description: 'Or: the element\'s visible text / label (e.g. "Register", "A."). Combined with selector, searches inside matches of selector.' },
              value: { type: 'string', description: 'Text to type, the option to select, the scroll direction, the key to press, or seconds to wait.' },
            },
            required: ['action'],
            additionalProperties: false,
          },
        },
      },
      required: ['description', 'steps'],
      additionalProperties: false,
    },
  },

  navigate: {
    label: 'Go to a page',
    readOnly: false,
    risk: 'medium',
    pageAction: true,
    description:
      'Open a URL in the inspected tab, or go back, forward or reload. Waits until the new page has loaded. ' +
      'Use it to move between pages while working on a task; links you can click are better followed with interact.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'One short sentence: where and why.' },
        url: { type: 'string', description: 'Absolute http(s) URL to open.' },
        go: { type: 'string', enum: ['back', 'forward', 'reload'], description: 'Or: go back, forward, or reload the page.' },
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
      'LAST RESORT. Propose JavaScript to run in the page. Only use when inject_css and modify_element cannot do the job. `code` is the body of an async function: you may use `await`, and `return` a JSON-serializable result (reported if it finishes within 30 seconds). Provide `undoCode` that reverses the effect whenever possible; say in `description` if it cannot be undone.',
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

// ───────────────────────────────────────────────────────────── compact mode (local models)

/**
 * One-line descriptions for compact mode. Local models (Ollama) have a small context window
 * (often 4–16K tokens), and the full descriptions plus the system prompt take ~6,500 of it,
 * so a task runs out of room after a few steps. The schemas stay the same, minus their
 * per-field descriptions; these lines carry what the model needs to call each action.
 */
const BRIEF = {
  inspect_element: 'Details of one element (ref, selector or the selected one): include any of computed_all, rules, ancestors, children, html.',
  find_elements: 'Search the page by CSS selector and/or visible text. Each match has a ref to target in interact.',
  page_outline: 'What is on screen: buttons, links and fields with refs, focused element, dialog, headings, visible text.',
  read_text: 'Read the text of the page or one element (ref/selector). Use offset=nextOffset for more.',
  inspect_console: 'Recent console messages and errors.',
  inspect_network: 'Network requests since DevTools opened (redacted).',
  inspect_resources: 'List page resources, or read one (readContentOf: exact URL).',
  screenshot: 'An image of an element (ref/selector) or of the visible page.',
  remember: 'Save one short, reusable fact about this site (scope "site" or "page_group"). No secrets.',
  forget: 'Delete a site-memory note by id.',
  define_page_group: 'Name this kind of page and its path pattern, e.g. "/book/*/*".',
  inject_css: 'Propose CSS for the page (the user applies it). Preferred way to change looks. Optional toggle: an on/off button.',
  modify_element: 'Propose changes to one element: styles, attributes, classes or text.',
  interact: 'Operate the page: steps of {action, ref|selector|text, value}. action: click, hover, type, select, check, uncheck, submit, '
    + 'scroll (value down/up/top/bottom), press (value: key), wait (value: seconds). Steps wait for the page to settle.',
  navigate: 'Open a URL in this tab (url), or go: back, forward, reload.',
  execute_js: 'Last resort: propose JavaScript (body of an async function) for the user to run; give undoCode if possible.',
};

/** Actions left out in compact mode: rarely needed, and every tool costs context. */
const COMPACT_LEAVE_OUT = new Set(['inspect_network', 'inspect_resources', 'define_page_group', 'forget']);

/**
 * The actions offered in compact mode.
 * @param {string[]} names enabled action names
 */
export function compactActionNames(names) {
  return names.filter((name) => !COMPACT_LEAVE_OUT.has(name));
}

/**
 * A schema with short field descriptions: the first sentence of each, at most 90 characters. The shape
 * and enums stay, so validation is unchanged. (Without any, small models lose track of what a field is
 * for: qwen3 kept leaving out interact's required "description" and putting one in every step instead.)
 * @param {Schema} schema
 * @returns {Schema}
 */
function withShortDescriptions(schema) {
  const rest = /** @type {any} */ ({ ...schema });
  if (rest.description) {
    const first = String(rest.description).split(/(?<=[\w)"]\.)\s+(?=[A-Z(])/)[0];
    rest.description = first.length > 90 ? `${first.slice(0, 89)}…` : first;
  }
  if (rest.properties) rest.properties = Object.fromEntries(Object.entries(rest.properties).map(([k, v]) => [k, withShortDescriptions(/** @type {Schema} */ (v))]));
  if (rest.items) rest.items = withShortDescriptions(rest.items);
  if (rest.anyOf) rest.anyOf = rest.anyOf.map(withShortDescriptions);
  return rest;
}

/**
 * An action as a tool for a model: full descriptions, or the compact form for local models.
 * @param {string} name
 * @param {boolean} [compact]
 * @returns {{ description: string, inputSchema: Schema }}
 */
export function toolSpec(name, compact = false) {
  const def = ACTIONS[name];
  return compact
    ? { description: BRIEF[/** @type {keyof typeof BRIEF} */ (name)] ?? def.description, inputSchema: withShortDescriptions(def.inputSchema) }
    : { description: def.description, inputSchema: def.inputSchema };
}

/** @param {string} name */
export function isKnownAction(name) {
  return Object.hasOwn(ACTIONS, name);
}

/** @param {string} name */
export function isReadOnly(name) {
  return isKnownAction(name) && ACTIONS[name].readOnly;
}

/** Site-memory actions handled by the server itself. @param {string} name */
export function isServerSide(name) {
  return isKnownAction(name) && ACTIONS[name].serverSide === true;
}

/** Actions that operate the page like the user (interact, navigate). @param {string} name */
export function isPageAction(name) {
  return isKnownAction(name) && ACTIONS[name].pageAction === true;
}

/**
 * Does this action run during the turn (with the result going back to the model)
 * rather than as a proposal card? Page actions do in the agent modes.
 * @param {string} name
 * @param {string | undefined} mode one of AGENT_MODES
 */
export function runsLive(name, mode) {
  return isPageAction(name) && !!mode && mode !== 'suggest' && AGENT_MODES.includes(/** @type {any} */ (mode));
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

/**
 * Drop optional fields a model set to null (small models write "frame": null for "no frame"), at any
 * depth, so they count as not given instead of failing validation. Required fields are kept as they are.
 * @param {string} name
 * @param {unknown} input
 * @returns {unknown}
 */
export function normalizeInput(name, input) {
  if (!isKnownAction(name)) return input;
  /** @param {any} value @param {Schema} schema @returns {any} */
  const clean = (value, schema) => {
    if (Array.isArray(value) && schema.items) return value.map((v) => clean(v, /** @type {Schema} */ (schema.items)));
    if (!value || typeof value !== 'object' || Array.isArray(value) || !schema.properties) return value;
    const required = new Set(schema.required ?? []);
    return Object.fromEntries(Object.entries(value)
      .filter(([key, v]) => !(v === null && !required.has(key)))
      .map(([key, v]) => [key, schema.properties?.[key] ? clean(v, schema.properties[key]) : v]));
  };
  return clean(input, ACTIONS[name].inputSchema);
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
  const isRef = (/** @type {unknown} */ ref) => typeof ref === 'string' && /^e\d{1,7}$/.test(ref);
  if (i.ref !== undefined && !isRef(i.ref)) errors.push('ref must look like "e12" (from find_elements or page_outline)');
  if (i.frame !== undefined) {
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(i.frame).protocol); } catch { /* not a URL */ }
    if (!ok) errors.push('frame must be the absolute http(s) URL of an iframe');
  }
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
  if (name === 'interact') {
    if (!i.steps.length || i.steps.length > 25) errors.push('interact needs 1–25 steps');
    i.steps.forEach((/** @type {any} */ s, /** @type {number} */ n) => {
      // scroll, press and wait can work without a target (the page, the focused element, a pause).
      if (s.ref !== undefined && !isRef(s.ref)) errors.push(`step ${n + 1}: ref must look like "e12"`);
      if (s.ref !== undefined && (s.selector !== undefined || s.text !== undefined)) errors.push(`step ${n + 1}: give a ref, or a selector and/or text, not both`);
      const targeted = s.ref || s.selector || s.text;
      if (!targeted && !['scroll', 'press', 'wait'].includes(s.action)) errors.push(`step ${n + 1}: give a ref, selector or text`);
      if ((s.action === 'type' || s.action === 'select' || s.action === 'press') && typeof s.value !== 'string') errors.push(`step ${n + 1}: ${s.action} needs a value`);
      if (s.action === 'scroll' && s.value !== undefined && !['down', 'up', 'top', 'bottom'].includes(s.value)) {
        errors.push(`step ${n + 1}: scroll value must be down, up, top or bottom`);
      }
      if (s.action === 'scroll' && s.value === undefined && !targeted) errors.push(`step ${n + 1}: scroll needs a direction or a target`);
      if (s.action === 'press' && typeof s.value === 'string' && !/^[A-Za-z0-9]{1,12}$/.test(s.value)) errors.push(`step ${n + 1}: press needs a key name like Enter or ArrowDown`);
      if (s.action === 'wait' && !targeted && !(Number(s.value) > 0 && Number(s.value) <= 10)) {
        errors.push(`step ${n + 1}: wait needs a target, or seconds (up to 10) as value`);
      }
    });
  }
  if (name === 'navigate') {
    if ((i.url === undefined) === (i.go === undefined)) errors.push('navigate needs either url or go');
    if (i.url !== undefined) {
      let ok = false;
      try { ok = ['http:', 'https:'].includes(new URL(i.url).protocol); } catch { /* not a URL */ }
      if (!ok) errors.push('url must be an absolute http(s) URL');
    }
  }
  if (name === 'inject_css' && /<\/?style/i.test(i.css)) {
    errors.push('css must be plain CSS without <style> tags');
  }
  if (name === 'remember' && (!i.note.trim() || i.note.length > 300)) errors.push('note must be 1–300 characters');
  if (name === 'define_page_group') {
    if (!i.name.trim() || i.name.length > 40) errors.push('name must be 1–40 characters');
    if (!/^\/[^\s?#]*$/.test(i.pattern) || i.pattern.length > 200) errors.push('pattern must be a path starting with "/" (no spaces, ? or #)');
  }
  if (name === 'inject_css' && i.toggle) {
    for (const key of ['label', 'activeLabel']) {
      if (typeof i.toggle[key] === 'string' && (i.toggle[key].length > 40 || !i.toggle[key].trim())) {
        errors.push(`toggle.${key} must be 1–40 characters`);
      }
    }
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
        description: 'Inspections to run or changes to propose. Empty array if none. These actions are not callable tools: listing them here is the only way to use them.',
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
