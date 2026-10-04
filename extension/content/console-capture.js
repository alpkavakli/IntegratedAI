// Runs in the PAGE's own JavaScript world ("world": "MAIN") at document_start,
// before the page's scripts. It records console messages and uncaught errors in
// a small ring buffer so the AI panel can read them later with inspectedWindow.eval.
//
// Why: Chrome has no DevTools extension API for reading the Console. The
// alternative (chrome.debugger) shows a warning bar and conflicts with DevTools.
//
// It never changes what the page sees: every wrapped console method still calls
// the original. Nothing is sent anywhere; the buffer stays in the page until read.
(() => {
  const KEY = Symbol.for('integratedai.console');
  if (window[KEY]) return; // already installed (e.g. injected twice)

  const MAX_ENTRIES = 300;
  const MAX_TEXT = 2000;
  const entries = [];
  let nextId = 1;

  /** Turn any console argument into a short readable string. */
  function stringify(value) {
    try {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
      if (value instanceof Element) {
        return `<${value.localName}${value.id ? `#${value.id}` : ''}${value.classList.length ? `.${[...value.classList].join('.')}` : ''}>`;
      }
      if (typeof value === 'object' && value !== null) return JSON.stringify(value).slice(0, 500);
      return String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }

  function record(level, message, extra = {}) {
    message = String(message).slice(0, MAX_TEXT);
    const last = entries[entries.length - 1];
    // Collapse repeats, like the DevTools console does.
    if (last && last.level === level && last.message === message) {
      last.count++;
      last.time = Date.now();
      return;
    }
    entries.push({ id: nextId++, level, message, time: Date.now(), count: 1, ...extra });
    if (entries.length > MAX_ENTRIES) entries.shift();
  }

  for (const level of ['error', 'warn', 'info', 'log']) {
    const original = console[level];
    console[level] = function (...args) {
      try {
        const errorArg = args.find((a) => a instanceof Error);
        record(level, args.map(stringify).join(' '), errorArg?.stack ? { stack: String(errorArg.stack).slice(0, MAX_TEXT) } : {});
      } catch {
        /* never break the page */
      }
      return original.apply(this, args);
    };
  }

  window.addEventListener('error', (event) => {
    // Resource load failures (img/script 404) arrive here with a target element.
    if (event.target && event.target !== window && event.target instanceof Element) {
      const el = event.target;
      record('error', `Failed to load ${el.localName}: ${el.src || el.href || ''}`, { kind: 'resource' });
      return;
    }
    // Chrome's message already starts with "Uncaught …".
    const message = /^uncaught/i.test(event.message) ? event.message : `Uncaught ${event.message}`;
    record('error', message, {
      kind: 'uncaught',
      stack: event.error?.stack ? String(event.error.stack).slice(0, MAX_TEXT) : undefined,
      source: event.filename ? { url: event.filename, line: event.lineno, column: event.colno } : undefined,
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    record('error', `Unhandled promise rejection: ${stringify(reason)}`, {
      kind: 'rejection',
      stack: reason?.stack ? String(reason.stack).slice(0, MAX_TEXT) : undefined,
    });
  });

  Object.defineProperty(window, KEY, {
    value: { entries, clear: () => entries.splice(0) },
    enumerable: false,
  });
})();
