# IntegratedAI: an AI panel for Chrome DevTools

An **"AI" tab inside Chrome DevTools** (not a browser sidebar) that can see the page you are
inspecting, especially the element selected in the Elements panel (`$0`). It explains layout,
styling and console problems, and proposes changes. You preview each change, apply it, undo it,
and can save CSS fixes as **persistent per-site patches**.

The AI runs through a **local Node.js agent server**. By default it uses your **Claude Code
subscription login** (`claude -p`), so no API key is needed.

```
Chrome DevTools ── "AI" panel (extension)
        │  ws://127.0.0.1:7823  (Origin check + pairing token)
        ▼
Local agent server (Node.js, plain ESM JavaScript)
        │
        ├── Claude Code CLI provider   (claude -p, your subscription)   ← default
        └── Anthropic API provider     (only if you configure an API key)
            (+ OpenAI / Gemini / Ollama / OpenRouter / … later: one file each)
```

**The model never runs anything by itself.** It can only *read* the page (inspections) and
*propose* changes. Every change is a card that you preview and approve.

---

## Requirements

- Chrome 116+ (or another Chromium browser)
- Node.js 20+
- [Claude Code](https://code.claude.com) installed and logged in (`claude` works in a terminal)

## Setup

```bash
npm install
npm start
```

On first start the server creates `~/.integratedai/config.json` and prints a **pairing token**:

```
IntegratedAI agent server listening on http://127.0.0.1:7823
Pairing token: 3kQ…
  provider claude-cli  available
  provider anthropic   unavailable: No API key. …
```

Load the extension:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder.
3. Click **Details → Extension options**, paste the pairing token, then click **Test connection**.
4. Reload any tab that was already open, so the console capture starts there.
5. Open DevTools (F12). There is a new **AI** tab.

For local `file://` pages, also turn on *Allow access to file URLs* in the extension's details.

## Using it

The core workflow:

1. Inspect an element in **Elements**.
2. Switch to **AI**. The `$0 h1.title` chip shows what will be sent.
3. Ask: *"why is this overflowing?"*, *"make this look better"*, *"hide this"*, *"make this dark"*.
4. The AI gets a **small** context for `$0`: its selector, about 40 key computed styles (boring defaults removed), its box, overflow facts, its parent, and a short HTML excerpt. If it needs more (matching CSS rules, ancestors, children, network, resources), it asks with an inspection, which runs automatically by default.
5. It proposes a change as a card.
6. Click **Preview** to see it, **Apply** to keep it, **Undo** to revert it.
7. For CSS changes, click **Save as site patch…** and choose the scope:
   - Whole site (origin)
   - This page (URL prefix)
   - A custom URL pattern, such as `https://*.example.com/app/*`

Context chips above the input box control what is sent with each message:

- **$0** is on by default.
- **Console** sends recent errors and warnings.
- **Network** sends failed and recent requests.

Defaults can be changed in Options.

| Tab | What it does |
|---|---|
| **Chat** | Conversation, action cards, provider/model picker, cost meter |
| **Patches** | Saved CSS patches: enable/disable, edit, delete. Enabled patches are reapplied whenever a matching page loads, even when DevTools is closed. Patches with a **toggle** also get an on/off button on the page itself. |
| **Console** | Errors and warnings captured on the page, each with **Explain** (asks the AI) and **Open source** (jumps to Sources) |

**Conversations are per tab.** They survive closing DevTools, reloads and navigation in the same
tab. A browser restart starts fresh. Conversations are never merged just because two tabs share
an origin. **New** starts a new conversation for the tab. Old conversations stay on disk in
`~/.integratedai/conversations/` for a future "resume" feature.

## Actions (what the model can do)

Defined once in [extension/shared/actions.js](extension/shared/actions.js) and validated on **both** the server and the panel.

| Action | Kind | Undo |
|---|---|---|
| `find_elements` | read: search the page by selector or visible text (e.g. find the nav bar); page landmarks by default | — |
| `inspect_element` | read: computed styles, matching CSS rules, ancestors, children, HTML | — |
| `inspect_console` | read: captured console messages | — |
| `inspect_network` | read: DevTools network log, sensitive headers/params redacted, no bodies | — |
| `inspect_resources` | read: page resources, or the source text of one | — |
| `inject_css` | **change**: add a stylesheet (preferred). Optional `toggle`: an on/off button on the page | full (removeCSS) |
| `modify_element` | **change**: styles, attributes, classes or text of one element | full (snapshot restore) |
| `execute_js` | **change**: arbitrary JS. **Off by default.** | only if the model provided `undoCode` (best effort) |

Read-only inspections run automatically unless you enable *"Ask before the AI reads page details"* in Options.

**Web search.** The AI can also search the web and read web pages (documentation, MDN, browser support). It is on by default; turn it off in Options. With the Claude Code CLI provider these are Claude Code's / tools, and nothing else is enabled. With the Anthropic API provider, the server-side / tools are used.

### Toggle buttons (theme switches, reading mode, …)

Ask for something you want to switch on and off from the page, for example *"add a toggle in the nav bar to switch between light and dark theme"* or *"a reading mode button in the header"*:

1. The AI uses  to locate the nav bar, writes the CSS, and proposes  with a  such as .
2. Apply it, then click **Save as site patch + toggle…**.
3. A real button appears in the nav bar. Clicking it switches the patch on and off, and the choice is remembered across reloads and visits.

The button is created by the extension's own content script (, in an isolated world), not by model-written JavaScript, so this works with  disabled. If the target element is not found (e.g. the site changed), the button floats in the bottom-right corner instead.

## Security model

- **Approval:** changes are never executed by the server. The panel runs them only after a click. `execute_js` also requires ticking "I reviewed this code", and its card says whether it can be undone.
- **Validation:** every action is validated against its JSON Schema on the server *and* again in the panel just before it runs, with extra rules:
  - no `on*` event-handler attributes
  - no `javascript:` URLs
  - no `srcdoc`
  - no `<style>` tags inside CSS
  - length limits on all inputs
- **Server access:**
  - The server listens on `127.0.0.1` only.
  - It rejects any Origin other than `chrome-extension://…`, which blocks websites.
  - It rejects non-local Host headers, which blocks DNS rebinding.
  - It requires the pairing token.
  - You can pin your extension ID with `allowedExtensionIds` in the config.
- **Network data:** cookies, authorization and API-key headers, and token-like query parameters are redacted. Response bodies are never sent.
- **Model output:** rendered with `textContent` only, never `innerHTML`. Page content is described to the model as untrusted data.
- **Claude Code CLI isolation:** the CLI runs in an empty folder. Only `WebSearch`/`WebFetch` can be enabled (via the web search setting); no file, shell or MCP tools. It also uses `--permission-mode dontAsk`, `--setting-sources ""` and `--disable-slash-commands`. The model can answer and search the web; it cannot touch your files.
- **Page content and toggle buttons:** web pages can only ask the service worker for their own toggle buttons and flip them. Every other command is restricted to extension pages.

## Configuration

`~/.integratedai/config.json` (set `INTEGRATEDAI_HOME` to use another folder). Restart the server after editing.

```jsonc
{
  "port": 7823,
  "token": "…",                       // pairing token (delete it to generate a new one)
  "allowedExtensionIds": [],          // e.g. ["abcdefghijklmnopabcdefghijklmnop"]
  "defaultProvider": "claude-cli",
  "maxStepsPerTurn": 8,               // max model calls per message (inspection round-trips)
  "providers": {
    "claude-cli": {
      "command": "claude",            // or a full path to claude.exe
      "model": "default",             // "default" = your Claude Code default; or opus / sonnet / haiku / fable
      "effort": null,                 // or "low" | "medium" | "high" | "xhigh" | "max"
      "maxBudgetUsdPerCall": null,
      "timeoutMs": 300000
    },
    "anthropic": {
      "apiKey": "",                   // or set ANTHROPIC_API_KEY; the provider stays hidden without a key
      "model": "claude-opus-5-5",
      "effort": "medium",
      "maxTokens": 32000,
      "fallbacks": true               // server-side refusal fallback (supported models)
    }
  }
}
```

**Cost meter.** The cost comes from what the provider reports:
- **Claude Code:** its own estimate (`total_cost_usd`). With a subscription this is usage against your plan, not a separate bill.
- **Anthropic API:** computed from token usage and the prices in [pricing.js](server/src/providers/pricing.js).

## Project layout

```
extension/                      ← load this folder in chrome://extensions (no build step)
  manifest.json
  shared/                       ← used by BOTH extension and server
    actions.js                  action catalog + schemas + safety validation
    validate.js                 tiny JSON-Schema validator (no dependencies)
    protocol.js                 WebSocket message types (documented)
    url-scope.js                patch scopes (origin / prefix / glob)
  devtools/devtools.{html,js}   registers the "AI" panel
  panel/
    panel.html / panel.css / panel.js   UI controller ("App")
    components/                 <ai-chat>, <ai-action-card>, <ai-patches>, <ai-console>
    lib/
      page-scripts.js           functions that run INSIDE the inspected page
      inspected.js              inspectedWindow.eval wrappers
      context.js                small per-message context ($0, console, network)
      inspections.js            read-only tools (+ header/URL redaction)
      changes.js                apply / preview / undo
      ws-client.js, settings.js, bg.js, dom.js, markdown.js
  background/service-worker.js  tab→conversation map, insertCSS/removeCSS, patches
  content/console-capture.js    MAIN-world console/error recorder (document_start)
  options/                      settings page
server/
  src/index.js                  HTTP + WebSocket server
  src/auth.js                   Origin/Host checks, token comparison
  src/connection.js             per-panel socket handling, routing
  src/agent/orchestrator.js     the turn loop and approval rules
  src/agent/system-prompt.js
  src/sessions/store.js         conversations as JSON files
  src/providers/
    base.js                     the Provider interface
    registry.js                 list of providers
    claude-cli.js               claude -p provider
    anthropic.js                Anthropic API provider
    _template.js                start here for a new provider
    common.js, pricing.js
  test/                         node:test unit tests
```

## How a turn works

1. The panel sends `chat.send` with your text and the small context.
2. The orchestrator calls the provider:
   - **Claude CLI** gets `--json-schema` for the `{ reply, actions[] }` envelope and `--session-id`/`--resume`, so one Claude Code session is kept per conversation.
   - **Anthropic API** gets native `strict` tools.
3. Inspections are sent to the panel (`tool.request`), run in the page, and their results go back to the model. This loops up to `maxStepsPerTurn` times.
4. Changes are sent as `action.proposed` and nothing more happens. When you apply, reject, undo or save, the panel reports it (`action.status`). The model receives your decision as the tool result at the start of your next message, so it knows what actually happened.

## Adding a provider

Copy [server/src/providers/_template.js](server/src/providers/_template.js), implement:
- `checkAvailability()`
- `turn()`, which yields `text_delta` / `tool_call` / `usage` / `done` events.

Then add the class to `PROVIDERS` in [registry.js](server/src/providers/registry.js). Approval, validation, page inspection and storage are handled for every provider by the orchestrator.

- **Providers with function calling** (OpenAI, Gemini, Ollama, OpenRouter, Grok) can pass `ACTIONS[name].inputSchema` directly as tool parameters.
- **Providers without tool calling** can reuse `envelopeSchema()` like the CLI provider does.

## Planned extensions (and where they plug in)

- **Apply to source:** add a provider-side step (or a separate server endpoint) that hands an *applied* `inject_css` and its page URL to Claude Code running in your project folder, with edit tools enabled. The action card would get an "Apply to source" button next to "Save as site patch". The patch data model already records `sourceUrl`.
- **Claude Code inspecting the page via MCP:** expose the four `inspect_*` actions as an MCP server from the agent server and pass `--mcp-config` in [claude-cli.js](server/src/providers/claude-cli.js). The orchestrator's `PanelLink.requestTool` already does the round-trip.
- **Element screenshots / vision:** capture `$0`'s box in the service worker (`chrome.tabs.captureVisibleTab` + crop), add an `image` content block to the neutral message format, and map it in providers that declare `capabilities.vision`.
- **Recent conversations / resume:** `SessionStore.listRecent()` exists; add a `sessions.list` protocol message and a picker.
- **Persistent JS patches:** deliberately left out; they need a stronger review flow.

## Tests

```bash
npm test
```

39 unit tests cover:
- action validation and safety rules
- auth (Origin, Host, token) and patch scopes
- CLI argument building and output parsing, including session resume, cost differences, recovery from a lost session, and decoding the streamed reply, and enabling only the web tools
- Anthropic message and tool conversion
- the orchestrator: inspection round-trips, proposals, decisions reported as tool results, disabled `execute_js`, usage, persistence

These were also checked manually against real Chrome and the real `claude` CLI during development:
- page scripts and console capture
- `insertCSS`/`removeCSS` under a strict CSP
- automatic patch reapplication
- the full panel UI flow: preview, apply, undo, save patch, toggle patch, Explain

## Debugging

- The server console logs every Claude Code call: `[claude-cli] resume 98a8e185: 6.2s, exit 0, prompt 1395 chars`.
- When a call fails, the full prompt, stdout and stderr are saved in `~/.integratedai/logs/`, and the error message in the panel shows the file path.
- Panel errors: right-click inside the AI panel, choose **Inspect**, and check its console.

## Known limitations

- DevTools extension APIs only work **while DevTools is open**. The network log only contains requests made since DevTools opened; reload to capture everything.
- Each Claude Code CLI call starts a new `claude` process, so the first words take a few seconds to appear (about 4–6 s). The reply then streams live. The streamed text is a preview; the stored reply is the schema-validated `structured_output`.
- Patches are inserted when navigation commits, so a very fast page may show its original style for a moment.
- Injected CSS doesn't automatically win specificity ties with the page's styles. The AI is instructed to use specific selectors or `!important`.
- Only the top frame is inspected and patched (no iframes).
- Console capture starts when the page loads; tabs opened before installing the extension need a reload.
- `execute_js` results that are Promises are started but not awaited.
- Undo info is tied to one page load: after a reload or navigation the page is fresh, so earlier cards show as no longer active.
- The page controls its own JS environment and could tamper with data returned to the panel. That only affects what the AI sees, never what gets executed without your click.
