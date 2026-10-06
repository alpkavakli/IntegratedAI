// @ts-check
/**
 * Native messaging host: lets the extension's "Server" button start and stop the local agent server,
 * so nobody has to run `npm start` by hand.
 *
 * Chrome starts this program for each message (chrome.runtime.sendNativeMessage) and talks to it over
 * stdin/stdout: a 4-byte length (native byte order) and UTF-8 JSON, each way. Only the extension IDs in
 * the host manifest may call it (see scripts/services.mjs, which registers it). It does exactly three
 * things and nothing else:
 *
 *   { cmd: 'status' } → { running, port, logFile }
 *   { cmd: 'start' }  → starts the server in the background (output to a log file), waits until it answers
 *   { cmd: 'stop' }   → asks the server to save and exit (POST /shutdown with the pairing token);
 *                        if it doesn't, ends the process it started
 */

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, loadConfig } from '../src/config.js';

const SERVER = fileURLToPath(new URL('../src/index.js', import.meta.url));
const dir = dataDir();
const PID_FILE = join(dir, 'server.pid');
const LOG_DIR = join(dir, 'logs');
const LOG_FILE = join(LOG_DIR, 'server.log');
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Read one message from Chrome. @returns {Promise<any>} */
function readMessage() {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    process.stdin.on('data', (chunk) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      if (all.length < 4) return;
      const size = all.readUInt32LE(0);
      if (size > 64 * 1024) reject(new Error('Message too large'));
      else if (all.length >= 4 + size) resolve(JSON.parse(all.subarray(4, 4 + size).toString('utf8')));
    });
    process.stdin.on('end', () => reject(new Error('No message')));
  });
}

/** Answer Chrome and exit. @param {unknown} value */
function reply(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]), () => process.exit(0));
}

/**
 * One HTTP request to the server, without keeping the connection (fetch keeps one open, and exiting
 * with it open crashes Node on Windows). Resolves the status code, or 0 if nothing answered.
 * @param {number} port
 * @param {string} method
 * @param {string} path
 * @param {Record<string, string>} [headers]
 * @returns {Promise<number>}
 */
function call(port, method, path, headers = {}) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false, timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end();
  });
}

/** Is the server answering on its port? @param {number} port */
async function running(port) {
  return (await call(port, 'GET', '/health')) === 200;
}

/** @param {number} port @param {boolean} want @param {number} ms */
async function waitFor(port, want, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await running(port)) === want) return true;
    await sleep(250);
  }
  return false;
}

/** @param {number} port */
async function start(port) {
  if (await running(port)) return { running: true, port, logFile: LOG_FILE, note: 'It was already running.' };
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(LOG_FILE, 'a');
  // Detached: the server keeps running after this helper exits (Chrome ends it after each message).
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  closeSync(out);
  if (child.pid) writeFileSync(PID_FILE, String(child.pid));
  const up = await waitFor(port, true, 15_000);
  if (!up) return { running: false, port, logFile: LOG_FILE, error: `The server did not start. See ${LOG_FILE}` };
  return { running: true, port, logFile: LOG_FILE };
}

/** @param {number} port @param {string} token */
async function stop(port, token) {
  if (!(await running(port))) return { running: false, port, logFile: LOG_FILE };
  await call(port, 'POST', '/shutdown', { 'x-integratedai-token': token });
  if (!(await waitFor(port, false, 5000)) && existsSync(PID_FILE)) {
    // It didn't exit by itself: end the process this helper started.
    try { process.kill(Number(readFileSync(PID_FILE, 'utf8')), 'SIGTERM'); } catch { /* already gone */ }
    await waitFor(port, false, 3000);
  }
  const still = await running(port);
  if (!still) rmSync(PID_FILE, { force: true });
  return { running: still, port, logFile: LOG_FILE, ...(still ? { error: 'The server is still running (perhaps started from a terminal: stop it there).' } : {}) };
}

try {
  const msg = await readMessage();
  const config = loadConfig();
  const port = config.port;
  if (msg?.cmd === 'status') reply({ running: await running(port), port, logFile: LOG_FILE });
  else if (msg?.cmd === 'start') reply(await start(port));
  else if (msg?.cmd === 'stop') reply(await stop(port, config.token));
  else reply({ error: `Unknown command ${JSON.stringify(msg?.cmd)}` });
} catch (err) {
  reply({ error: String(/** @type {any} */ (err)?.message ?? err) });
}
