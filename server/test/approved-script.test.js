import { test } from 'node:test';
import assert from 'node:assert/strict';

// The panel runs scripts with chrome.devtools.inspectedWindow.eval(); here Node's own eval
// plays the page (window = globalThis), so the real expressions from inspected.js run.
globalThis.window = globalThis;
globalThis.Element ??= class {};
globalThis.chrome = {
  devtools: {
    inspectedWindow: {
      eval(expression, _options, callback) {
        let result;
        try {
          result = (0, eval)(expression);
        } catch (e) {
          callback(undefined, { isException: true, value: String(e) });
          return;
        }
        callback(result);
      },
    },
  },
};
const { runApprovedScript } = await import('../../extension/panel/lib/inspected.js');

test('execute_js: plain and awaited results, errors, syntax errors', async () => {
  assert.deepEqual(await runApprovedScript('return 1 + 1;'), { ok: true, value: 2 });
  assert.deepEqual(await runApprovedScript('const r = await new Promise((ok) => setTimeout(() => ok({ items: 3 }), 30)); return r;', { pollMs: 5 }),
    { ok: true, value: { items: 3 } });
  const failed = await runApprovedScript('await null; throw new Error("nope");', { pollMs: 5 });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /nope/);
  await assert.rejects(runApprovedScript('return (;'), 'a syntax error rejects, as before');
  assert.deepEqual(await runApprovedScript('return;'), { ok: true, value: null });
});

test('execute_js: a slow script is not waited for forever; results are not left behind', async () => {
  const slow = await runApprovedScript('await new Promise((ok) => setTimeout(ok, 200)); return "late";', { timeoutMs: 30, pollMs: 5 });
  assert.match(slow.value, /still running after 0 s/);
  await runApprovedScript('return 1;');
  const scripts = window[Symbol.for('integratedai.state')].scripts;
  assert.deepEqual(Object.values(scripts), [null], 'only the still-running script has a slot');
});

test('execute_js: the page reloading while the script runs is reported', async () => {
  const run = runApprovedScript('await new Promise((ok) => setTimeout(ok, 50)); return 1;', { pollMs: 5 });
  window[Symbol.for('integratedai.state')].scripts = undefined; // a reload starts with fresh page state
  assert.match((await run).value, /reloaded or navigated/);
});
