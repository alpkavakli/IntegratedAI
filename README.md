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

### Memory: what it remembers between conversations

Memory has two layers, both stored by the server in `~/.integratedai/`, so it survives browser restarts.

**1. Site memory** (`memory/<site>.json`): short notes per site and per **page type**.
- The AI saves notes with the `remember` action when it learns something reusable, such as key selectors (`nav bar: nav.g_nav`), how the site is built, or your preferences (e.g. a dark theme you saved). It fixes wrong notes with `forget`.
- Notes are saved without asking, never touch the page, and show in the chat as **📝 Remembered …**.
- **Whole site** notes apply to every page of the site. **This kind of page** notes apply only to pages of the same page type.
- At the start of each conversation, and whenever the notes change, the AI receives the notes that apply to the current page (`<site_memory>`, a few hundred tokens). So it starts out knowing the site.
- The **Memory** tab shows everything: rename page types, edit, delete or add notes yourself (e.g. *"I prefer serif fonts for reading"*).

**Page types** (path categorisation): long, dynamic URLs are grouped by a path pattern. For example, `/book/lord-of-mysteries_11022733705139605/chapter-1_29558554638401523` becomes **"Chapter reader" = `/book/*/*`**.
- `*` matches one path part (any ID or slug). A final `**` matches anything below.
- An automatic guess replaces ID-like path parts with `*`.
- The AI names page types and fixes patterns with `define_page_group`. You can edit them in the Memory tab.
- Saved patches can also be scoped to a page type: **Save as site patch → "Pages like this: Chapter reader"**.

**2. Conversation history** (`conversations/`): every conversation is kept.
- **History** in the toolbar lists the conversations on this site, those about the same page type first. Clicking one continues it, and the Claude Code session is resumed too.
- A new conversation on a known site starts fresh but already knows the site memory. It offers **Continue "…"** for the latest conversation on that site, and shows how many things it remembers.

Notes come partly from page content, so they are treated as data, never as instructions. They are only shown for their own site, and you can see and delete every one.

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
| `screenshot` | read: an image of an element or of the visible page, so the AI can see colours and layout (shown to you in the chat too) | — |
| `inject_css` | **change**: add a stylesheet (preferred). Optional `toggle`: an on/off button on the page | full (removeCSS) |
| `modify_element` | **change**: styles, attributes, classes or text of one element | full (snapshot restore) |
| `execute_js` | **change**: arbitrary JS. **Off by default.** | only if the model provided `undoCode` (best effort) |

Read-only inspections run automatically unless you enable *"Ask before the AI reads page details"* in Options.

**Screenshots.** The panel captures the inspected tab (`chrome.tabs.captureVisibleTab`) and crops it to the element. An off-screen element is scrolled into view first, and the page is scrolled back afterwards. The image is resized to at most 1280 px and sent as a JPEG, and a thumbnail appears in the chat ("📷 The AI looked at …"; click it to enlarge).
- **Check it:** an applied or saved change has a **Check it** button. It asks the AI to screenshot the result and propose fixes for anything that still looks wrong, such as areas a dark theme missed or unreadable text.
- The inspected tab must be the visible tab in its window. With DevTools docked it always is.
- Only what's on screen can be captured: an element taller than the window is cut off.
- **Claude Code CLI:** the image comes back from the `mcp__page__screenshot` tool.
- **Anthropic API:** the image goes in the tool result. Only the last 3 screenshots are re-sent on later calls, because each one costs about 1–1.5k input tokens every time.

**Web search.** The AI can search the web and read web pages (documentation, MDN, browser support). It is on by default; turn it off in Options.
- **Claude Code CLI provider:** uses Claude Code's `WebSearch`/`WebFetch` tools, and nothing else is enabled.
- **Anthropic API provider:** uses the server-side `web_search`/`web_fetch` tools.

### Toggle buttons (theme switches, reading mode, …)

Ask for something you want to switch on and off from the page itself, for example:
- *"add a toggle in the nav bar to switch between light and dark theme"*
- *"a reading mode button in the header"*

What happens:
1. The AI uses `find_elements` to locate the nav bar and writes the CSS. It proposes `inject_css` with a `toggle`, such as `{ label: "🌙 Dark", activeLabel: "☀️ Light", placeSelector: "nav.g_nav" }`.
2. Apply it, then click **Save as site patch + toggle…**.
3. A real button appears in the nav bar. Clicking it switches the patch on and off, and the choice is remembered across reloads and visits.

The button is created by the extension's own content script (`content/patch-toggles.js`, in an isolated world), not by JavaScript the model wrote, so this works with `execute_js` disabled. If the target element isn't found (e.g. the site changed), the button floats in the bottom-right corner instead.

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
- **Screenshots:** a screenshot shows whatever is on screen in that tab, so it can include personal information the page displays. Like the other inspections, you can require approval for each one in Options. The panel shows every screenshot the AI takes.
- **Network data:** cookies, authorization and API-key headers, and token-like query parameters are redacted. Response bodies are never sent.
- **Model output:** rendered with `textContent` only, never `innerHTML`. Page content is described to the model as untrusted data.
- **Claude Code CLI isolation:** the CLI runs in an empty folder. It gets no file or shell tools. Only `WebSearch`/`WebFetch` can be enabled (via the web search setting), plus this server's own page inspections over MCP. Your own MCP servers are ignored (`--strict-mcp-config`). It also uses `--permission-mode dontAsk`, `--setting-sources ""` and `--disable-slash-commands`. The model can answer, read the page and search the web; it cannot touch your files.
- **The MCP endpoint (`POST /mcp`):** only offers the read-only inspections, never changes or memory updates. It needs a random token that is created for one Claude Code call and deleted when that call ends, and that token only reaches that conversation's page. Requests with a non-local Host or any Origin header (which every browser request has) are rejected.
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
  src/mcp.js                    POST /mcp: page inspections as MCP tools for Claude Code
  src/connection.js             per-panel socket handling, routing
  src/agent/orchestrator.js     the turn loop and approval rules
  src/agent/system-prompt.js
  src/agent/page-tools.js       per-call tokens and the inspections offered over MCP
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
   - **Claude CLI** gets `--json-schema` for the `{ reply, actions[] }` envelope and `--session-id`/`--resume`, so one Claude Code session is kept per conversation. It also gets `--mcp-config` pointing at this server's `/mcp` endpoint, so the inspections are real tools (`mcp__page__find_elements`, …) it can call while it works.
   - **Anthropic API** gets native `strict` tools.
3. Inspections are sent to the panel (`tool.request`), run in the page, and their results go back to the model. With the Anthropic API, and with Claude CLI inspections listed in `actions`, this loops up to `maxStepsPerTurn` times. Claude CLI's MCP tool calls are answered inside the same call.
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
- **Persistent JS patches:** deliberately left out; they need a stronger review flow.

## Tests

```bash
npm test
```

63 unit tests cover:
- action validation and safety rules
- auth (Origin, Host, token) and patch scopes
- CLI argument building and output parsing, including session resume, cost differences, recovery from a lost session, decoding the streamed reply, enabling only the web tools and our MCP page tools, and the one-time correction when a model calls page actions as tools
- Anthropic message and tool conversion
- the orchestrator: inspection round-trips, proposals, decisions reported as tool results, disabled `execute_js`, usage, persistence
- the MCP endpoint: only inspections are listed, calls reach the right conversation, inputs are validated, and tokens, Origin and Host are checked
- screenshots: images are split out of results (never sent as text), invalid ones dropped, returned as MCP image content, and sent to the Anthropic API as images, only the most recent few
- site memory and page types: URL categorisation, note scopes, renaming groups, memory sent only when it changes, history per site

These were also checked manually against real Chrome and the real `claude` CLI during development:
- page scripts and console capture
- `insertCSS`/`removeCSS` under a strict CSP
- automatic patch reapplication
- the full panel UI flow: preview, apply, undo, save patch, toggle patch, Explain
- Claude Code (Sonnet) calling the page inspections over MCP: through the real server on a new and a resumed session, and with the real panel code in Chromium on a webnovel-like test page (the panel ran in a tab with a `chrome.devtools` stand-in). There, "Make a toggle button in the nav bar…" found `nav.g_nav`, and Apply, Save as site patch + toggle, reload and the toggle all worked.
- screenshots with the real panel code in Chromium: of the nav bar, and of a footer 2,400 px below the fold. The page was scrolled to the footer and back, and Sonnet read both images correctly.

## Debugging

- The server console logs every Claude Code call: `[claude-cli] resume 98a8e185: 6.2s, exit 0, prompt 1395 chars`.
- When a call fails, the full prompt, stdout and stderr are saved in `~/.integratedai/logs/`, and the error message in the panel shows the file path.
- Panel errors: right-click inside the AI panel, choose **Inspect**, and check its console.
- `[mcp] Rejected …` / `Missing or expired token` lines mean something other than the current Claude Code call reached `/mcp`, or the call had already ended.
- `[claude-cli] model called inject_css as tools; asking it to retry` means the model tried to call an action that isn't a tool (changes and memory updates must go in `actions`). The server resumes the session once with a correction, and the panel shows "↻ Retrying with the page tools…". If the answer still says it couldn't inspect the page, send the error log or the conversation file from `~/.integratedai/conversations/`.

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
