// @ts-check
/**
 * WebSocket client for the agent server, with automatic reconnect.
 *
 * Usage:
 *   const client = new ServerClient(() => loadSettings());
 *   client.addEventListener('message', (e) => handle(e.detail));
 *   client.addEventListener('status', (e) => show(e.detail));  // 'connecting' | 'connected' | 'disconnected' | 'unauthorized'
 *   client.connect();
 *   const reply = await client.request({ type: 'providers.list' });
 */

import { PROTOCOL_VERSION } from '../../shared/protocol.js';

const REQUEST_TIMEOUT_MS = 30_000;

export class ServerClient extends EventTarget {
  /** @param {() => Promise<{ serverUrl: string, token: string }>} getSettings */
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.status = 'disconnected';
    this.lastError = '';
    this.retryDelay = 1000;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: number }>} */
    this.pending = new Map();
    /** @type {number | undefined} */
    this.retryTimer = undefined;
    this.stopped = false;
  }

  async connect() {
    clearTimeout(this.retryTimer);
    this.stopped = false;
    const { serverUrl, token } = await this.getSettings();
    if (!token) {
      this.setStatus('unauthorized', 'No pairing token set. Open the extension options.');
      return;
    }
    this.setStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(serverUrl);
    } catch (err) {
      this.setStatus('disconnected', String(err));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, protocol: PROTOCOL_VERSION }));
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.retryDelay = 1000;
        this.setStatus('connected');
        return;
      }
      if (msg.type === 'error' && this.status !== 'connected') this.lastError = msg.message;
      if (msg.replyTo && this.pending.has(msg.replyTo)) {
        const p = this.pending.get(msg.replyTo);
        this.pending.delete(msg.replyTo);
        clearTimeout(p?.timer);
        if (msg.type === 'error') p?.reject(new Error(msg.message));
        else p?.resolve(msg);
        return;
      }
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Disconnected')); }
      this.pending.clear();
      if (event.code === 4401) {
        this.setStatus('unauthorized', this.lastError || 'The server rejected the pairing token.');
        return; // don't retry with a bad token; settings change triggers reconnect
      }
      this.setStatus('disconnected', this.lastError || 'Server not reachable. Is `npm start` running?');
      this.scheduleReconnect();
    };
  }

  /** Close and reconnect (e.g. after settings changed). */
  reconnect() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.connect();
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
  }

  /**
   * @param {string} status
   * @param {string} [error]
   */
  setStatus(status, error = '') {
    this.status = status;
    this.lastError = error;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, error } }));
  }

  /** Fire-and-forget message. @param {object} msg */
  send(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN || this.status !== 'connected') {
      throw new Error('Not connected to the agent server');
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Send a message and wait for the reply (matched by id).
   * @param {Record<string, unknown>} msg
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  request(msg, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The server did not answer'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...msg, id });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }
}
