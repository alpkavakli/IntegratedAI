import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoPattern, isValidPattern, matchPattern, resolveGroup, siteKey } from '../../extension/shared/page-groups.js';
import { validateAction } from '../../extension/shared/actions.js';
import { MemoryStore } from '../src/memory/store.js';
import { Orchestrator } from '../../extension/shared/agent/orchestrator.js';
import { Provider } from '../../extension/shared/providers/base.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SessionStore } from '../src/sessions/store.js';
import { testConfig } from './helpers.js';

const CHAPTER = 'https://www.webnovel.com/book/lord-of-mysteries_11022733705139605/chapter-1-crimson_29558554638401523';
const CHAPTER_2 = 'https://www.webnovel.com/book/shadow-slave_22196546206090805/chapter-5_59595934859102344?from=x';

// ─────────────────────────────────────────────── page groups

test('siteKey: host without www; no memory for browser pages', () => {
  assert.equal(siteKey(CHAPTER), 'webnovel.com');
  assert.equal(siteKey('http://localhost:3000/a'), 'localhost:3000');
  assert.equal(siteKey('file:///C:/x.html'), 'local-files');
  assert.equal(siteKey('chrome://settings'), null);
});

test('autoPattern turns dynamic segments into wildcards', () => {
  assert.equal(autoPattern(new URL(CHAPTER).pathname), '/book/*/*');
  assert.equal(autoPattern(new URL(CHAPTER_2).pathname), '/book/*/*');
  assert.equal(autoPattern('/'), '/');
  assert.equal(autoPattern('/search'), '/search');
  assert.equal(autoPattern('/u/12345/settings'), '/u/*/settings');
  assert.equal(autoPattern('/p/550e8400-e29b-41d4-a716-446655440000'), '/p/*');
  assert.equal(autoPattern('/docs/getting-started'), '/docs/getting-started');
});

test('matchPattern: * is one segment, final ** is the rest', () => {
  assert.equal(matchPattern('/book/*/*', '/book/a/b'), true);
  assert.equal(matchPattern('/book/*/*', '/book/a'), false);
  assert.equal(matchPattern('/book/*/*', '/book/a/b/c'), false);
  assert.equal(matchPattern('/book/**', '/book/a/b/c'), true);
  assert.equal(matchPattern('/book/**', '/book'), true);
  assert.equal(matchPattern('/', '/'), true);
  assert.equal(isValidPattern('/a/**/b'), false);
  assert.equal(isValidPattern('book/*'), false);
});

test('resolveGroup prefers the most specific named group', () => {
  const groups = [
    { id: 'a', name: 'Anything in book', pattern: '/book/**' },
    { id: 'b', name: 'Chapter reader', pattern: '/book/*/*' },
  ];
  assert.equal(resolveGroup(groups, '/book/x/y').name, 'Chapter reader');
  assert.equal(resolveGroup(groups, '/book/x').name, 'Anything in book');
  assert.deepEqual(resolveGroup(groups, '/ranking'), { name: null, pattern: '/ranking', auto: true });
});

// ─────────────────────────────────────────────── memory store

test('notes: site vs page-group scope, dedupe, context only shows what applies', () => {
  const mem = new MemoryStore(testConfig().dataDir);
  mem.addNote(CHAPTER, { text: 'Nav bar: nav.g_nav', scope: 'site', by: 'assistant' });
  mem.addNote(CHAPTER, { text: 'Chapter text: .cha-words p', scope: 'page_group', by: 'assistant' });
  mem.addNote(CHAPTER, { text: 'nav bar: NAV.G_NAV', scope: 'site', by: 'assistant' }); // duplicate (case-insensitive)
  mem.addNote('https://webnovel.com/ranking', { text: 'Ranking uses .rank-list', scope: 'page_group', by: 'user' });

  const here = mem.contextFor(CHAPTER_2); // a different chapter, same page group
  assert.deepEqual(here.notes.map((n) => n.text), ['Nav bar: nav.g_nav', 'Chapter text: .cha-words p']);
  assert.equal(here.pageGroup.pattern, '/book/*/*');
  assert.equal(here.pageGroup.named, false);

  const ranking = mem.contextFor('https://www.webnovel.com/ranking');
  assert.deepEqual(ranking.notes.map((n) => n.text), ['Nav bar: nav.g_nav', 'Ranking uses .rank-list']);
});

test('defineGroup names the page type, keeps notes attached, and must match the page', () => {
  const mem = new MemoryStore(testConfig().dataDir);
  mem.addNote(CHAPTER, { text: 'Chapter text: .cha-words p', scope: 'page_group', by: 'assistant' });
  assert.throws(() => mem.defineGroup(CHAPTER, { name: 'Search', pattern: '/search' }), /does not match/);

  mem.defineGroup(CHAPTER, { name: 'Chapter reader', pattern: '/book/**' });
  let ctx = mem.contextFor(CHAPTER_2);
  assert.deepEqual(ctx.pageGroup, { name: 'Chapter reader', pattern: '/book/**', named: true });
  assert.equal(ctx.notes.length, 1, 'note moved from the automatic pattern to the named group');

  // Same name again → the group's pattern is refined, notes follow.
  mem.defineGroup(CHAPTER, { name: 'Chapter reader', pattern: '/book/*/*' });
  ctx = mem.contextFor(CHAPTER_2);
  assert.equal(ctx.pageGroup.pattern, '/book/*/*');
  assert.equal(ctx.notes.length, 1);
  assert.equal(mem.load('webnovel.com').groups.length, 1);
});

test('memory persists on disk', () => {
  const dir = testConfig().dataDir;
  new MemoryStore(dir).addNote(CHAPTER, { text: 'Prefers dark themes', scope: 'site', by: 'user' });
  assert.equal(new MemoryStore(dir).contextFor(CHAPTER).notes[0].text, 'Prefers dark themes');
});

test('memory actions are validated', () => {
  assert.deepEqual(validateAction('remember', { note: 'x', scope: 'site' }), []);
  assert.match(validateAction('remember', { note: 'x', scope: 'everywhere' }).join(), /must be one of/);
  assert.match(validateAction('define_page_group', { name: 'A', pattern: 'book/*' }).join(), /pattern/);
});

// ─────────────────────────────────────────────── orchestrator + history

function setup(steps) {
  const config = testConfig({ defaultProvider: 'scripted' });
  const seen = [];
  class Scripted extends Provider {
    static id = 'scripted';
    static models = ['m'];
    static async checkAvailability() { return { available: true }; }
    async *turn({ messages }) {
      seen.push(structuredClone(messages));
      for (const ev of steps.shift() ?? [{ type: 'text_delta', text: 'ok' }]) yield ev;
      yield { type: 'done', stopReason: 'end_turn' };
    }
  }
  const sent = [];
  const panel = { send: (_id, msg) => sent.push(msg), requestTool: async () => ({ ok: true, result: { found: 1 } }) };
  const store = new SessionStore(config.dataDir);
  const memory = new MemoryStore(config.dataDir);
  const orchestrator = new Orchestrator({ store, registry: new ProviderRegistry(config, [Scripted]), config, panel, memory });
  return { orchestrator, store, memory, seen, sent };
}
const ctx = (url) => ({ page: { url, title: 't' } });

test('remember at the end of a turn: saved immediately, result sent with the next message', async () => {
  const { orchestrator, memory, seen, sent } = setup([
    [{ type: 'text_delta', text: 'Done.' }, { type: 'tool_call', id: 'm1', name: 'remember', input: { note: 'Nav bar: nav.g_nav', scope: 'site' } }],
    [{ type: 'text_delta', text: 'ok' }],
  ]);
  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'find the nav', context: ctx(CHAPTER) });

  assert.equal(seen.length, 1, 'no extra model call just to acknowledge a memory note');
  assert.equal(memory.contextFor(CHAPTER).notes[0].text, 'Nav bar: nav.g_nav');
  assert.ok(sent.some((m) => m.type === 'memory.changed' && m.change.kind === 'note_added'));

  await orchestrator.chat(session, { text: 'thanks', context: ctx(CHAPTER) });
  const next = seen[1].at(-1).content;
  assert.equal(next[0].type, 'tool_result');
  assert.match(next[0].content, /Saved/);
  assert.ok(!next.some((b) => b.type === 'memory'), 'memory not resent: the model wrote it itself');
});

test('a new conversation on the same site starts with the site memory; resent only when it changes', async () => {
  const { orchestrator, memory, seen } = setup([]);
  memory.addNote(CHAPTER, { text: 'Prefers dark themes', scope: 'site', by: 'user' });

  const session = await orchestrator.openSession({});
  await orchestrator.chat(session, { text: 'hi', context: ctx(CHAPTER_2) });
  const first = seen[0].at(-1).content.find((b) => b.type === 'memory');
  assert.equal(first.data.notes[0].text, 'Prefers dark themes');

  await orchestrator.chat(session, { text: 'again', context: ctx(CHAPTER_2) });
  assert.ok(!seen[1].at(-1).content.some((b) => b.type === 'memory'), 'unchanged memory is not repeated');

  memory.addNote(CHAPTER, { text: 'Hide comment bubbles', scope: 'page_group', by: 'user' });
  await orchestrator.chat(session, { text: 'and now', context: ctx(CHAPTER_2) });
  assert.equal(seen[2].at(-1).content.find((b) => b.type === 'memory').data.notes.length, 2);
});

test('history: conversations are listed per site with title, page group and last URL', async () => {
  const { orchestrator, store } = setup([]);
  const a = await orchestrator.openSession({});
  await orchestrator.chat(a, { text: 'Make a dark theme toggle in the nav bar', context: ctx(CHAPTER) });
  const b = await orchestrator.openSession({});
  await orchestrator.chat(b, { text: 'Why is the ranking list cut off?', context: ctx('https://www.webnovel.com/ranking') });
  const other = await orchestrator.openSession({});
  await orchestrator.chat(other, { text: 'unrelated', context: ctx('https://example.com/') });
  await store.flush();

  const list = store.listForSite('webnovel.com');
  assert.deepEqual(list.map((e) => e.title).sort(), ['Make a dark theme toggle in the nav bar', 'Why is the ranking list cut off?']);
  const chapterConv = list.find((e) => e.id === a.id);
  assert.equal(chapterConv.groupPattern, '/book/*/*');
  assert.equal(chapterConv.lastUrl, CHAPTER);

  // The index survives a restart (rebuilt from disk if needed).
  const reloaded = new SessionStore(store.dir.replace(/[\\/]conversations$/, ''));
  assert.equal(reloaded.listForSite('webnovel.com').length, 2);
});
