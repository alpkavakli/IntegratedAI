// @ts-check
/**
 * IntegratedAI agent server.
 *
 *   npm start
 *
 * Listens on http://127.0.0.1:7823 (configurable):
 *   GET /health   → { ok: true }               (no data, no auth: lets the panel show "server running")
 *   WS  /ws       → the DevTools panel protocol (see extension/shared/protocol.js)
 *   POST /mcp     → page inspections as MCP tools for Claude Code (see mcp.js)
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { checkUpgrade } from './auth.js';
import { loadConfig } from './config.js';
import { Connection, PanelHub } from './connection.js';
import { Orchestrator } from '../../extension/shared/agent/orchestrator.js';
import { PageTools } from './agent/page-tools.js';
import { handleMcpRequest } from './mcp.js';
import { ProviderRegistry } from './providers/registry.js';
import { SessionStore } from './sessions/store.js';
import { MemoryStore } from './memory/store.js';
import { SourceEditor } from './source/source-editor.js';
import { prepareDataDir } from './storage/data-version.js';
import { readFileSync } from 'node:fs';

const config = loadConfig();
const appVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
// Version the data folder before anything reads it (backs up and migrates after an update).
try {
  const data = prepareDataDir(config.dataDir, { appVersion });
  if (data.backup) console.log(`Updated your data from version ${data.from} to ${data.to}. Backup: ${data.backup}`);
  for (const step of data.ran) console.log(`  migrated ${step}`);
} catch (err) {
  console.error(String(/** @type {any} */ (err)?.message ?? err));
  process.exit(1);
}
const store = new SessionStore(config.dataDir);
const memory = new MemoryStore(config.dataDir);
const registry = new ProviderRegistry(config);
const hub = new PanelHub();
const sourceEditor = new SourceEditor(config);
const pageTools = new PageTools(hub);
const orchestrator = new Orchestrator({ store, registry, config, panel: hub, memory, pageTools });

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/mcp') {
    handleMcpRequest(req, res, { pageTools, port: config.port }).catch((err) => {
      console.error(`[mcp] ${err?.message ?? err}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const check = req.url === '/ws' ? checkUpgrade(req, config) : { ok: false, reason: 'Unknown path' };
  if (!check.ok) {
    console.warn(`[auth] ${/** @type {any} */ (check).reason}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    new Connection(ws, { config, hub, orchestrator, store, registry, memory, sourceEditor });
  });
});

server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, async () => {
  console.log(`IntegratedAI agent server listening on http://${config.host}:${config.port}`);
  console.log(`Data folder:   ${config.dataDir}`);
  console.log(`Pairing token: ${config.token}`);
  console.log('Paste the token into the extension options (right-click the extension → Options).');
  for (const p of await registry.list()) {
    console.log(`  provider ${p.id.padEnd(11)} ${p.available ? 'available' : `unavailable: ${p.reason}`}`);
  }
});

// Save pending conversation writes before exiting.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await store.flush();
    process.exit(0);
  });
}
