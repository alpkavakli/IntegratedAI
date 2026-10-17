import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipEntries, zipEntryStream } from '../../extension/shared/zip-read.js';
import { conversationToDoc, exportConversations, savedContext, splitJsonArray, MAX_CHAT_CHARS } from '../../extension/shared/chatgpt-export.js';
import { chatSearcher, excerpts, queryWords, scoreChat } from '../../extension/shared/chat-search.js';
import { exportedChat, makeZip } from './helpers.js';
import { AREA_ACTIONS, CARD_ACTIONS, actionsForAccess, enabledActionNames, isReadOnly, validateAction } from '../../extension/shared/actions.js';
import { buildSystemPrompt } from '../../extension/shared/agent/system-prompt.js';

const text = async (stream) => new TextDecoder().decode(await new Response(stream).arrayBuffer());
/** A string as chunks of a few characters (the way a big file arrives), cutting through strings and escapes. */
async function* inChunks(s, size = 7) { for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size); }
const collect = async (gen) => { const out = []; for await (const x of gen) out.push(x); return out; };

test('zip: entries are listed and unpacked, also from a ZIP64 archive (what files over 4 GB use)', async () => {
  for (const zip64 of [false, true]) {
    const blob = new Blob([makeZip([{ name: 'user.json', data: '{"id":1}' }, { name: 'conversations.json', data: 'x'.repeat(5000) + 'END' }], { zip64 })]);
    const entries = await zipEntries(blob);
    assert.deepEqual(entries.map((e) => e.name), ['user.json', 'conversations.json'], `zip64: ${zip64}`);
    assert.equal(entries[1].size, 5003);
    assert.ok(entries[1].compressedSize < 100, 'deflated');
    assert.equal(await text(await zipEntryStream(blob, entries[0])), '{"id":1}');
    assert.ok((await text(await zipEntryStream(blob, entries[1]))).endsWith('xxEND'));
  }
  await assert.rejects(zipEntries(new Blob(['not a zip at all, just text that is long enough'])), /not a ZIP file/);
});

test('export: a JSON array is split into its elements as it streams by, whatever is inside them', async () => {
  const items = [{ a: 'plain' }, { b: 'brackets ] } [ { and a quote \\" and a backslash \\\\' }, { c: [1, [2, { d: '}' }]], e: 'ünïcödé 🙂' }, 7, 'str,ing', true, null];
  const json = JSON.stringify(items, null, 1);
  for (const size of [1, 3, 7, 1000]) {
    const parts = await collect(splitJsonArray(inChunks(json, size)));
    assert.deepEqual(parts.map((p) => JSON.parse(p)), items, `chunks of ${size}`);
  }
  assert.deepEqual(await collect(splitJsonArray(inChunks('[]'))), []);
  assert.deepEqual((await collect(splitJsonArray(inChunks('  [ {"x":1} ]  ')))).map((p) => JSON.parse(p)), [{ x: 1 }]);
});

test('export: a conversation becomes who said what, in order: the thread the user saw, without hidden parts', () => {
  const chat = exportedChat('c1', 'Trip plan', [['user', 'Where should I go in May?'], ['assistant', 'Lisbon is lovely in May.'], ['user', 'Book it.']]);
  // An edited message leaves another branch in the tree; system and tool messages and images are in it too.
  chat.mapping.alt = { id: 'alt', parent: 'm0', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['An answer that was regenerated away.'] }, metadata: {} } };
  chat.mapping.m1.message.content = { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer' }, 'Lisbon is lovely in May.'] };
  chat.mapping.root.message = { author: { role: 'system' }, content: { content_type: 'text', parts: ['You are ChatGPT'] }, metadata: {} };
  const doc = conversationToDoc(chat);
  assert.equal(doc.id, 'c1');
  assert.equal(doc.title, 'Trip plan');
  assert.equal(doc.text, 'You: Where should I go in May?\n\nChatGPT: Lisbon is lovely in May.\n\nYou: Book it.');
  assert.equal(doc.time, (1_760_000_000 + 3) * 1000);
  assert.equal(conversationToDoc({ title: 'Empty', mapping: {} }), null);
  assert.equal(conversationToDoc({ nonsense: true }), null);
  const long = conversationToDoc(exportedChat('c2', 'Long', [['user', 'a'.repeat(MAX_CHAT_CHARS + 500)]]));
  assert.ok(long.text.length < MAX_CHAT_CHARS + 100 && /cut: a very long conversation/.test(long.text));
});

test('export: ChatGPT\'s saved memory and custom instructions are picked up when the export has them', () => {
  const chat = exportedChat('c1', 'T', [['user', 'hi']]);
  chat.mapping.ctx = { id: 'ctx', message: { author: { role: 'system' }, content: { content_type: 'model_editable_context', model_set_context: '1. Lives in Singapore.\n2. Studies CS.' } } };
  chat.mapping.me = { id: 'me', message: { author: { role: 'user' }, content: { content_type: 'user_editable_context', user_profile: 'I am a student.', user_instructions: 'Be brief.' } } };
  assert.deepEqual(savedContext(chat), { memory: '1. Lives in Singapore.\n2. Studies CS.', instructions: 'I am a student.\n\nBe brief.' });
  assert.deepEqual(savedContext(exportedChat('c2', 'T', [['user', 'hi']])), {});
});

test('export: conversations are read from the ZIP ChatGPT sends, or from conversations.json itself', async () => {
  const chats = [exportedChat('a', 'First', [['user', 'one']]), exportedChat('b', 'Second', [['user', 'two']])];
  const json = JSON.stringify(chats);
  const zip = new Blob([makeZip([{ name: 'chat.html', data: '<html>' }, { name: 'conversations.json', data: json }, { name: 'user.json', data: '{}' }])]);
  assert.deepEqual((await collect(exportConversations(zip))).map((c) => c.title), ['First', 'Second']);
  assert.deepEqual((await collect(exportConversations(new Blob([json])))).map((c) => c.conversation_id), ['a', 'b']);
  await assert.rejects(collect(exportConversations(new Blob([makeZip([{ name: 'photo.png', data: 'x' }])]))), /No conversations\.json/);
});

test('search: the words that matter, best match first, with excerpts around what was found', () => {
  assert.deepEqual(queryWords('What did I decide about the Lisbon trip?'), ['decide', 'lisbon', 'trip']);
  assert.deepEqual(queryWords('the'), ['the'], 'only small words: use them anyway');
  const docs = [
    { id: '1', title: 'Trip plan', time: 2000, text: 'You: Where should I go in May?\n\nChatGPT: Lisbon is lovely in May. Book the flight early.' },
    { id: '2', title: 'Cooking', time: 3000, text: 'You: How long do I boil an egg?\n\nChatGPT: Seven minutes.' },
    { id: '3', title: 'Lisbon trip budget', time: 1000, text: 'You: What does the Lisbon trip cost?\n\nChatGPT: About 900 euros with the flight.' },
  ];
  const search = chatSearcher('Lisbon trip', 5);
  docs.forEach((d) => search.add(d));
  const { matches, total } = search.results();
  assert.equal(total, 2);
  assert.deepEqual(matches.map((m) => m.id), ['3', '1'], 'the one with the phrase and the title first');
  assert.equal(matches[0].date, '1970-01-01');
  assert.match(matches[0].excerpts[0], /Lisbon trip cost/);
  // At least half the words have to be there.
  assert.equal(scoreChat(docs[1], queryWords('Lisbon trip budget'), 'lisbon trip budget'), 0);
  // Case and accents as typed: Turkish text is found.
  assert.ok(scoreChat({ title: 'Staj', text: 'Kredi Kayıt Bürosu stajı' }, queryWords('kredi kayıt'), 'kredi kayıt') > 0);
  // Excerpts: a window around each place, merged when they overlap, marked when cut.
  const long = `${'intro '.repeat(100)}the secret word is ZEBRA here${' outro'.repeat(100)}`;
  const cut = excerpts(long, ['zebra'], 'zebra');
  assert.equal(cut.length, 1);
  assert.ok(cut[0].startsWith('…') && cut[0].endsWith('…') && cut[0].includes('ZEBRA') && cut[0].length < 450);
});

test('search: only the best few are kept, however many chats go by', () => {
  const search = chatSearcher('budget', 3);
  for (let i = 0; i < 50; i++) search.add({ id: String(i), title: i % 10 === 0 ? 'Budget' : 'Other', time: i, text: 'the budget for this month' });
  const { matches, total } = search.results();
  assert.equal(total, 50);
  assert.deepEqual(matches.map((m) => m.id), ['40', '30', '20'], 'title matches first, the newest of them first');
});

test('search_chats: offered only when the user switched it on; a read-only tool that stays with every page access', () => {
  assert.ok(!enabledActionNames({}).includes('search_chats'));
  const on = enabledActionNames({ pastChats: true });
  assert.ok(on.includes('search_chats') && isReadOnly('search_chats'));
  // The user's own chats are not part of the page: there with an area, and with "Just answer" (the only tool then).
  assert.ok(AREA_ACTIONS.includes('search_chats') && CARD_ACTIONS.includes('search_chats'));
  assert.deepEqual(actionsForAccess(on, 'none'), ['search_chats']);
  assert.deepEqual(actionsForAccess(enabledActionNames({}), 'none'), []);

  assert.deepEqual(validateAction('search_chats', { query: 'lisbon trip' }, { pastChats: true }), []);
  assert.deepEqual(validateAction('search_chats', { id: 'c1', offset: 8000 }, { pastChats: true }), []);
  assert.match(validateAction('search_chats', {}, { pastChats: true })[0], /needs a query/);
  assert.match(validateAction('search_chats', { query: 'x' }, {})[0], /disabled/);
});

test('search_chats: the prompt explains the chats only when the tool is there', () => {
  const withChats = buildSystemPrompt({ actionNames: enabledActionNames({ pastChats: true }) });
  assert.match(withChats, /## The user's past ChatGPT chats/);
  assert.match(withChats, /snapshot/);
  assert.doesNotMatch(buildSystemPrompt({ actionNames: enabledActionNames({}) }), /past ChatGPT chats/);
  // "Just answer" with the chats: both sections.
  const justAnswer = buildSystemPrompt({ actionNames: ['search_chats'], pageAccess: 'none' });
  assert.match(justAnswer, /past ChatGPT chats/);
  assert.match(justAnswer, /## Just answer/);
});
