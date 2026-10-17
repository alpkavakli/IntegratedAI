import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FRAMES, SHEET_MAX_SIDE, clock, encodeWav, peakLevel, sheetLayout, watchPlan } from '../../extension/shared/video-watch.js';
import { formatResult } from '../../extension/shared/agent/format-result.js';
import { toOpenAIMessages } from '../../extension/shared/providers/openai-compatible.js';
import { toAnthropicMessages } from '../../extension/shared/providers/anthropic.js';
import { AREA_ACTIONS, CARD_ACTIONS, enabledActionNames, isReadOnly, validateAction } from '../../extension/shared/actions.js';
import { buildSystemPrompt } from '../../extension/shared/agent/system-prompt.js';

const IMG = { mediaType: 'image/jpeg', data: 'AAAA' };
const WAV = { mediaType: 'audio/wav', data: 'UklGRg==' };

test('watch plan: to the end of the video, at most a minute, a picture every 1.5 s or more', () => {
  assert.deepEqual(watchPlan({}, { duration: 20, currentTime: 2 }), { seconds: 18, everyMs: 1500 });
  assert.equal(watchPlan({}, { duration: 600, currentTime: 0 }).seconds, 60, 'long videos: a minute');
  assert.equal(watchPlan({}, { duration: null, currentTime: 0 }).seconds, 30, 'unknown length (a live stream): half a minute');
  assert.equal(watchPlan({}, { duration: 10, currentTime: 9.5 }).seconds, 3, 'near the end: a few seconds (it loops or stops)');
  assert.equal(watchPlan({ seconds: 8 }, { duration: 100, currentTime: 0 }).seconds, 8);
  const long = watchPlan({ seconds: 60 }, { duration: null, currentTime: 0 });
  assert.ok(60_000 / long.everyMs + 1 <= MAX_FRAMES, 'never more pictures than the limit');
});

test('contact sheets: portrait videos in rows of 6, wide ones in rows of 4, never larger than the AI takes', () => {
  const reel = sheetLayout(12, 9 / 16);
  assert.equal(reel.cols, 6);
  assert.equal(reel.rows, 2);
  assert.ok(reel.width <= SHEET_MAX_SIDE && reel.height <= SHEET_MAX_SIDE);
  const wide = sheetLayout(12, 16 / 9);
  assert.equal(wide.cols, 4);
  assert.equal(wide.rows, 3);
  assert.ok(wide.width <= SHEET_MAX_SIDE && wide.height <= SHEET_MAX_SIDE);
  assert.equal(sheetLayout(2, 16 / 9).cols, 2, 'two pictures: side by side');
  assert.equal(clock(65.4), '1:05');
  assert.equal(clock(0), '0:00');
});

test('sound: a 16 kHz mono WAV file, and silence is noticed', () => {
  const samples = Float32Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.5 : -1.5));
  const wav = encodeWav(samples, 16000);
  const v = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), 'WAVE');
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(22, true), 1, 'mono');
  assert.equal(wav.length, 44 + 32);
  assert.equal(v.getInt16(44, true), -32768, 'clipped to -1');
  assert.equal(v.getInt16(46, true), Math.trunc(0.5 * 0x7fff));
  assert.equal(peakLevel(new Float32Array(100)), 0);
  assert.equal(peakLevel(samples), 1.5);
});

test('results: several pictures and a sound are taken out of the text and kept as attachments', () => {
  const out = formatResult({ video: 'video', images: [IMG, IMG], audio: WAV, sound: 'attached (0:12)' });
  assert.equal(out.images.length, 2);
  assert.deepEqual(out.audio, WAV);
  assert.doesNotMatch(out.text, /AAAA|UklGRg/);
  assert.match(out.text, /"images":"2 attached"/);
  const bad = formatResult({ images: [IMG, { mediaType: 'text/html', data: 'x' }], audio: { mediaType: 'audio/mp3', data: 'x' } });
  assert.equal(bad.images.length, 1);
  assert.equal(bad.audio, undefined);
  assert.match(bad.text, /1 of 2 attached/);
  assert.match(bad.text, /"audio":"missing/);
});

const watched = (/** @type {string} */ id) => ([
  { role: 'assistant', ts: 0, content: [{ type: 'tool_call', id, name: 'watch_video', input: {} }] },
  { role: 'user', ts: 0, content: [{ type: 'tool_result', toolCallId: id, content: '{"sound":"attached"}', images: [IMG], audio: WAV }] },
]);

test('providers: the sound goes to AIs that can listen (the newest only); the others are told it was left out', () => {
  const history = /** @type {any[]} */ ([{ role: 'user', ts: 0, content: [{ type: 'text', text: 'watch these' }] }, ...watched('v1'), ...watched('v2')]);
  const gemini = toOpenAIMessages('S', history, { audio: true });
  const sent = gemini.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'input_audio');
  assert.equal(sent.length, 1, 'only the newest sound');
  assert.deepEqual(sent[0].input_audio, { data: WAV.data, format: 'wav' });
  assert.match(gemini.find((m) => m.tool_call_id === 'v1').content, /no longer attached/);
  assert.doesNotMatch(gemini.find((m) => m.tool_call_id === 'v2').content, /attached\)|can't hear/);

  const openai = toOpenAIMessages('S', history, {});
  assert.ok(!JSON.stringify(openai).includes('input_audio'));
  assert.match(openai.find((m) => m.tool_call_id === 'v2').content, /can't hear it/);
  assert.ok(JSON.stringify(openai).includes('image_url'), 'the pictures still go');

  const claude = JSON.stringify(toAnthropicMessages(history));
  assert.ok(!claude.includes(WAV.data));
  assert.match(claude, /can't hear it/);
});

test('watch_video: a read-only tool, everywhere the screenshot is; the prompt explains it', () => {
  assert.ok(enabledActionNames({}).includes('watch_video') && isReadOnly('watch_video'));
  assert.ok(CARD_ACTIONS.includes('watch_video') && AREA_ACTIONS.includes('watch_video'));
  assert.deepEqual(validateAction('watch_video', {}), []);
  assert.deepEqual(validateAction('watch_video', { ref: 'e3', seconds: 20 }), []);
  assert.match(validateAction('watch_video', { seconds: 600 })[0], /3–60/);
  const prompt = buildSystemPrompt({ actionNames: enabledActionNames({}) });
  assert.match(prompt, /## Videos/);
  assert.match(prompt, /write a line about what it showed/);
});
