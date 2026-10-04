import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceEditor, buildSourceArgs, checkEdits, safePath } from '../src/source/source-editor.js';
import { testConfig } from './helpers.js';

/** A small project: src/site.css, src/app.css (CRLF). */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'iai-proj-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/site.css'), '.nav {\n  background: white;\n}\n\n.footer { color: #333; }\n');
  writeFileSync(join(root, 'src/app.css'), 'body {\r\n  color: black;\r\n}\r\n');
  return root;
}

test('checkEdits: exact unique replacement, new files, CRLF files', () => {
  const root = project();
  const { files, previews } = checkEdits(root, [
    { file: 'src/site.css', oldText: '.nav {\n  background: white;\n}', newText: '.nav {\n  background: #121212;\n}' },
    { file: 'src/app.css', oldText: 'body {\n  color: black;\n}', newText: 'body {\n  color: #ddd;\n}' },
    { file: 'src/theme/dark.css', oldText: '', newText: ':root { --bg: #121212; }\n' },
  ]);
  assert.equal(files['src/site.css'].after, '.nav {\n  background: #121212;\n}\n\n.footer { color: #333; }\n');
  assert.equal(files['src/app.css'].after, 'body {\r\n  color: #ddd;\r\n}\r\n', 'line endings kept');
  assert.equal(files['src/theme/dark.css'].before, null);
  assert.deepEqual(previews.map((p) => [p.file, p.isNew, p.line]), [['src/site.css', false, 1], ['src/app.css', false, 1], ['src/theme/dark.css', true, 1]]);
});

test('checkEdits: refuses edits that would be ambiguous or wrong', () => {
  const root = project();
  writeFileSync(join(root, 'src/dup.css'), 'a{}\na{}\n');
  const bad = (edit, re) => assert.throws(() => checkEdits(root, [edit]), re);
  bad({ file: 'src/site.css', oldText: 'nope', newText: 'x' }, /not found/);
  bad({ file: 'src/dup.css', oldText: 'a{}', newText: 'b{}' }, /more than once/);
  bad({ file: 'src/missing.css', oldText: 'x', newText: 'y' }, /does not exist/);
  bad({ file: 'src/site.css', oldText: '', newText: 'overwrite' }, /already exists/);
  bad({ file: 'src/site.css', oldText: 1, newText: 'x' }, /Malformed/);
});

test('safePath: stays inside the project', () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), 'iai-outside-'));
  let canLink = true;
  try { symlinkSync(outside, join(root, 'link'), 'dir'); } catch { canLink = false; } // Windows without developer mode
  const files = ['../x.css', '/etc/passwd', 'C:/Windows/x', 'src/../../x', '.git/config', 'node_modules/a/b.css', ''];
  if (canLink) files.push('link/evil.css');
  for (const file of files) {
    assert.throws(() => safePath(root, file), /outside|Invalid|not editable/, file);
  }
  assert.equal(safePath(root, 'src/site.css').endsWith(join('src', 'site.css')), true);
});

test('projectFor: longest matching URL prefix, only from config', () => {
  const a = project();
  const b = project();
  const editor = new SourceEditor(testConfig({ projects: [
    { name: 'site', path: a, urls: ['http://localhost:3000'] },
    { name: 'admin', path: b, urls: ['http://localhost:3000/admin'] },
  ] }));
  assert.equal(editor.projectFor('http://localhost:3000/admin/users')?.name, 'admin');
  assert.equal(editor.projectFor('http://localhost:3000/')?.name, 'site');
  assert.equal(editor.projectFor('https://m.webnovel.com/'), null);
  assert.equal(new SourceEditor(testConfig()).projectFor('http://localhost:3000/'), null);
});

/** A fake `claude` that answers with the given structured output, and records the call. */
function fakeClaude(answer) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ args, cwd: opts.cwd, input: opts.input });
    return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.02, structured_output: answer }) };
  };
  return { run, calls };
}

test('propose → write → undo; nothing is written before "write"', async () => {
  const root = project();
  const { run, calls } = fakeClaude({
    summary: 'The nav is styled in src/site.css.',
    edits: [
      { file: 'src/site.css', oldText: 'background: white;', newText: 'background: #121212;' },
      { file: 'src/dark.css', oldText: '', newText: '.x{}' },
    ],
    notes: '',
  });
  const config = testConfig({ projects: [{ path: root, urls: ['http://localhost:3000'] }] });
  const editor = new SourceEditor(config, { run });
  const p = await editor.propose({ url: 'http://localhost:3000/', css: '.nav{background:#121212!important}', description: 'Dark nav' });

  assert.equal(calls[0].cwd, root);
  assert.match(calls[0].input, /\.nav\{background:#121212!important\}/);
  assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], 'Read,Glob,Grep', 'read-only tools');
  assert.equal(calls[0].args[calls[0].args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.match(readFileSync(join(root, 'src/site.css'), 'utf8'), /background: white/, 'not written yet');
  assert.equal(existsSync(join(root, 'src/dark.css')), false);

  assert.deepEqual(editor.write(p.id), ['src/site.css', 'src/dark.css']);
  assert.match(readFileSync(join(root, 'src/site.css'), 'utf8'), /background: #121212/);
  assert.equal(readFileSync(join(root, 'src/dark.css'), 'utf8'), '.x{}');
  assert.throws(() => editor.write(p.id), /Already written/);

  // After a restart the backup is still there.
  const restarted = new SourceEditor(config, { run });
  assert.deepEqual(restarted.undo(p.id), { restored: ['src/site.css', 'src/dark.css'], skipped: [] });
  assert.match(readFileSync(join(root, 'src/site.css'), 'utf8'), /background: white/);
  assert.equal(existsSync(join(root, 'src/dark.css')), false, 'new file removed');
});

test('write refuses files changed since the proposal; undo skips files you edited since', async () => {
  const root = project();
  const answer = { summary: '', notes: '', edits: [{ file: 'src/site.css', oldText: 'background: white;', newText: 'background: black;' }] };
  const editor = new SourceEditor(testConfig({ projects: [{ path: root, urls: ['http://x/'] }] }), fakeClaude(answer));

  const p1 = await editor.propose({ url: 'http://x/', css: 'a{}' });
  writeFileSync(join(root, 'src/site.css'), '/* edited */\n.nav { background: white; }\n');
  assert.throws(() => editor.write(p1.id), /changed since/);

  const p2 = await editor.propose({ url: 'http://x/', css: 'a{}' });
  editor.write(p2.id);
  writeFileSync(join(root, 'src/site.css'), 'my own edit');
  assert.deepEqual(editor.undo(p2.id), { restored: [], skipped: ['src/site.css'] });
  assert.equal(readFileSync(join(root, 'src/site.css'), 'utf8'), 'my own edit');
});

test('propose: unsafe edits from the model are rejected, errors are reported', async () => {
  const root = project();
  const config = testConfig({ projects: [{ path: root, urls: ['http://x/'] }] });
  const escape = new SourceEditor(config, fakeClaude({ summary: '', notes: '', edits: [{ file: '../evil.css', oldText: '', newText: 'x' }] }));
  await assert.rejects(escape.propose({ url: 'http://x/', css: 'a{}' }), /outside the project/);

  const failing = new SourceEditor(config, { run: async () => ({ code: 1, stderr: '', stdout: JSON.stringify({ type: 'result', is_error: true, subtype: 'error', result: 'Credit balance too low' }) }) });
  await assert.rejects(failing.propose({ url: 'http://x/', css: 'a{}' }), /Credit balance too low/);

  await assert.rejects(new SourceEditor(config).propose({ url: 'http://elsewhere/', css: 'a{}' }), /No project folder/);
});

test('buildSourceArgs: read-only, none of your settings, hooks or MCP servers', () => {
  const args = buildSourceArgs({ model: 'sonnet', systemPromptFile: 'p.md' });
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.ok(!args.join(' ').match(/Edit|Write|Bash/), 'no edit or shell tools');
});
