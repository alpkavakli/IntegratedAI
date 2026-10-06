// @ts-check
/**
 * The panel's requests (see ../protocol.js) answered the same way everywhere:
 * by the agent server (server/src/connection.js) and by the extension's direct
 * mode (panel/direct/direct-client.js).
 *
 * createRequestHandler() returns handle(msg):
 *   → a reply object ({ type, … }) to send back with replyTo = msg.id
 *   → null       handled, nothing to send (e.g. chat.send: the turn streams events)
 *   → undefined  not a shared request; the caller handles it (server-only features)
 * Errors are thrown; callers turn them into { type: 'error' } replies.
 */

import { matchPattern, pathOf, siteKey } from '../page-groups.js';

export const MAX_TEXT = 20_000;

/**
 * @param {{
 *   orchestrator: import('./orchestrator.js').Orchestrator,
 *   store: import('./orchestrator.js').SessionStore & { listForSite: (site: string) => any[] | Promise<any[]> },
 *   registry: import('./orchestrator.js').ProviderRegistry & { list: () => Promise<any[]> },
 *   memory: import('./memory.js').MemoryStore,
 *   onSession?: (session: import('./session-model.js').Session) => void,
 * }} deps  onSession: called when a request concerns a conversation (the server routes its events to this panel)
 */
export function createRequestHandler({ orchestrator, store, registry, memory, onSession = () => {} }) {
  /** @param {unknown} id */
  const load = async (id) => {
    const session = await store.get(String(id ?? ''));
    if (!session) throw new Error('Conversation not found');
    return session;
  };

  /**
   * The memory a conversation uses; without a conversation id, the shared site memory.
   * @param {unknown} conversationId
   */
  const memoryOf = async (conversationId) => {
    const session = conversationId ? await store.get(String(conversationId)) : null;
    const mode = session?.memoryMode ?? 'shared';
    return { mode, mem: session ? orchestrator.memoryFor(session) : memory };
  };

  /** @param {any} msg */
  return async function handle(msg) {
    switch (msg.type) {
      case 'session.open':
      case 'session.reset': {
        const session = await orchestrator.openSession({
          conversationId: msg.type === 'session.open' ? msg.conversationId : undefined,
          url: String(msg.url ?? ''),
          title: String(msg.title ?? ''),
        });
        onSession(session);
        return { type: 'session.state', session: orchestrator.snapshot(session) };
      }

      case 'session.config': {
        const session = await load(msg.conversationId);
        orchestrator.configure(session, { provider: msg.provider, model: msg.model, memoryMode: msg.memoryMode, agentMode: msg.agentMode });
        return { type: 'session.state', session: orchestrator.snapshot(session) };
      }

      case 'providers.list':
        return { type: 'providers', providers: await registry.list() };

      case 'chat.send': {
        const session = await load(msg.conversationId);
        const text = String(msg.text ?? '').slice(0, MAX_TEXT);
        if (!text.trim()) throw new Error('Empty message');
        onSession(session);
        // Not awaited: the turn streams events back while it runs.
        orchestrator.chat(session, {
          text,
          context: msg.context,
          settings: {
            executeJs: msg.settings?.executeJs === true,
            webTools: msg.settings?.webTools === true,
            // The default mode for this conversation; "full" can only be chosen per conversation.
            agentMode: ['suggest', 'ask', 'auto'].includes(msg.settings?.agentMode) ? msg.settings.agentMode : 'suggest',
            // The basic card on the page (opened from the toolbar button) instead of the DevTools panel.
            ...(msg.settings?.surface === 'card' ? { surface: /** @type {const} */ ('card') } : {}),
          },
        });
        return null;
      }

      case 'chat.cancel':
        orchestrator.cancel(String(msg.conversationId));
        return null;

      case 'action.status': {
        const session = await load(msg.conversationId);
        orchestrator.setActionStatus(session, String(msg.actionId), String(msg.status), msg.detail);
        return null;
      }

      case 'sessions.list': {
        // Conversations on this site; those about the same kind of page first.
        const url = String(msg.url ?? '');
        const site = siteKey(url);
        const path = pathOf(url);
        const items = site
          ? (await store.listForSite(site)).map((e) => ({ ...e, sameGroup: matchPattern(e.groupPattern, path) }))
          : [];
        items.sort((a, b) => Number(b.sameGroup) - Number(a.sameGroup) || b.updatedAt - a.updatedAt);
        return { type: 'sessions', site, items };
      }

      case 'memory.get': {
        // The memory the conversation uses (shared site memory, its private memory, or none).
        const { mem, mode } = await memoryOf(msg.conversationId);
        return { type: 'memory', mode, memory: mem ? mem.forUrl(String(msg.url ?? '')) : null };
      }

      case 'memory.edit': {
        // Edits from the Memory tab. Always scoped to the site of the given URL.
        const url = String(msg.url ?? '');
        const site = siteKey(url);
        if (!site) throw new Error('This page has no site memory');
        const { mem: target, mode } = await memoryOf(msg.conversationId);
        if (!target) throw new Error('Memory is turned off for this conversation');
        const memory = target; // eslint-disable-line no-shadow
        switch (msg.op) {
          case 'addNote': memory.addNote(url, { text: String(msg.text ?? ''), scope: msg.scope === 'page_group' ? 'page_group' : 'site', by: 'user' }); break;
          case 'updateNote': memory.updateNote(site, String(msg.noteId), String(msg.text ?? '')); break;
          case 'deleteNote': memory.deleteNote(site, String(msg.noteId)); break;
          case 'defineGroup': memory.defineGroup(url, { name: String(msg.name ?? ''), pattern: String(msg.pattern ?? '') }); break;
          case 'updateGroup': memory.updateGroup(site, String(msg.groupId), { name: msg.name, pattern: msg.pattern }); break;
          case 'deleteGroup': memory.deleteGroup(site, String(msg.groupId)); break;
          default: throw new Error(`Unknown memory operation "${msg.op}"`);
        }
        return { type: 'memory', mode, memory: memory.forUrl(url) };
      }

      default:
        return undefined;
    }
  };
}
