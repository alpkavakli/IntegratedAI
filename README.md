**I made this AI slop which you will be using for more AI slop**

# IntegratedAI: an AI panel for Chrome DevTools

An **"AI" tab inside Chrome DevTools** (not a browser sidebar) that can see the page you are
inspecting, especially the element selected in the Elements panel (`$0`). It explains layout,
styling and console problems, and proposes changes. You preview each change, apply it, undo it,
and can save CSS fixes as **persistent per-site patches**.

The AI runs in one of two ways (see [Two ways to run it](#two-ways-to-run-it)):

```
Direct mode (default): nothing to install
  Chrome DevTools ── "AI" panel (extension, runs the agent itself)
        └── your own API key: Anthropic, OpenAI, Google Gemini, OpenRouter
            or Ollama on your computer (no key)

Local server mode (for developers)
  Chrome DevTools ── "AI" panel (extension)
        │  ws://127.0.0.1:7823  (Origin check + pairing token)
        ▼
  Local agent server (Node.js, plain ESM JavaScript)
        ├── Claude Code CLI provider   (claude -p, your Claude subscription)   ← default
        └── Anthropic API provider     (only if you configure an API key)
```

**The model never runs anything by itself.** It can only *read* the page (inspections) and
*propose* changes. Every change is a card that you preview and approve.

---

## Two ways to run it

Choose in **Options → Connection**:

| | **Direct** (default for new installs) | **Local agent server** |
|---|---|---|
| Setup | Paste an API key for Anthropic, OpenAI, Google Gemini or OpenRouter, or use [Ollama](https://ollama.com) on your computer (no key; see below). Nothing else to install. | Node.js 20+ and [Claude Code](https://code.claude.com), then `npm start` (below) |
| Pays with | Your account with that provider | Your Claude subscription (via Claude Code), or an API key |
| Where conversations and memory live | In the browser (IndexedDB, extension storage) | `~/.integratedai/` on your computer |
| Extras | — | "Apply to source"; page tools as real Claude Code tools |

**Models from China-based companies:** DeepSeek, Qwen (Alibaba Cloud Model Studio), Kimi (Moonshot AI), GLM (Z.ai)
and MiniMax work like the other API-key providers, with tools and agent modes. They are thinking models that return
their reasoning as `reasoning_content` and want it back with the next requests (DeepSeek refuses requests without
it): the extension keeps it with each answer and sends it back to the same provider, without showing it. Qwen needs
your own Model Studio address (it contains your workspace); Kimi, GLM and MiniMax accounts in mainland China use other
addresses. The setup page has an **API address** field for these, with the address to use. Model ids checked
2026-10-07 against each provider's documentation; **Check key** lists what your key can use.

Both use the **same agent code** (`extension/shared/agent/`: orchestrator, prompts, memory, request handling). In direct mode it runs inside the extension: Anthropic through a vendored build of the official SDK (`extension/vendor/`, regenerate with `npm run vendor:sdk`); OpenAI, Gemini, OpenRouter and Ollama through their OpenAI-compatible Chat Completions API (`extension/shared/providers/openai-compatible.js`; another compatible service is one more preset there).

**Ollama (free, local models).** Install [Ollama](https://ollama.com/download), download a model that supports tools
(`ollama pull qwen3`), allow browser extensions to call it (Ollama refuses them by default), and raise its context
length: Ollama gives models 4,096 tokens by default (less on small GPUs), and the extension's instructions and tools
alone are about 6,500, so with the default Ollama silently cuts them off and the model loses its instructions.
- Windows: `setx OLLAMA_ORIGINS "chrome-extension://*"` and `setx OLLAMA_CONTEXT_LENGTH 16384`, then quit Ollama from the tray and start it again.
- macOS: `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"` and `launchctl setenv OLLAMA_CONTEXT_LENGTH 16384`, then restart the Ollama app.
- Linux (systemd): add `Environment="OLLAMA_ORIGINS=chrome-extension://*"` and `Environment="OLLAMA_CONTEXT_LENGTH=16384"` with `systemctl edit ollama`, then restart it.

On a GPU with 8 GB, also setting `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` keeps an 8B model plus 16K of context
in video memory. If your model can only have 8K tokens of context or less, turn on **Short prompts for Ollama**
(Options → Advanced settings): a short system prompt and tool descriptions (about 2,800 tokens instead of 6,600),
fewer tools, and only the newest results and page context in full. With 16K or more, leave it off: in tests,
qwen3:8b followed the full prompt more reliably.

The setup page shows these steps for Windows, macOS or Linux (it picks your system), with Copy buttons.

**Freeing your graphics card:** Ollama keeps a model loaded for 5 minutes after the last message (that's the fans).
The panel's **Unload** button (the chip icon, shown while Ollama is the provider) unloads it right away; the next
message loads it again. To quit Ollama itself, use its own icon by the clock or in the menu bar.
While Ollama is the provider, the panel checks that it is running (every 10 s while visible): if not, the dot
turns red and a banner says how to start it, before a message fails.

**Switching between connections:** the provider menu ends with the other connection: "Claude Code (local server)"
while you use an API key or Ollama, and the direct providers you set up while you use the server. Each keeps its own
conversations.

Then pick **Ollama** in Options and click **Check connection**: it lists your models, checks that Ollama accepts the
extension, and warns if the chosen model can't use tools. Small local models follow the instructions less reliably
than the hosted ones; larger models give better results.

**Separate memories:** each conversation uses the site's shared memory (default), a private memory of its own, or none: choose in the Memory tab or from the empty chat.

**Copy text:** the button next to the context chips copies the selected element's text to the clipboard. The extension does this itself; no AI is involved.

### Quick start (direct mode)

1. Install the extension (from the Chrome Web Store, or: `chrome://extensions` → **Developer mode** → **Load unpacked** → the `extension/` folder). The setup page opens.
2. **Choose your AI.** Easiest: an API key (Claude, Gemini (free tier), GPT, OpenRouter). Free and private: Ollama
   (the page shows the commands for your system, with Copy buttons). For developers: Claude Code through the local server.
3. **Paste your API key.** It's saved and checked right away (Ollama and the server have a **Check connection** button
   instead, which says which step is missing, including an Ollama context window that is too small).
4. **Start using it** (step 3 of the setup page): the toolbar icon or Alt+Shift+A opens the card on any page
   (**Try it now** opens an article with it), F12 → **AI** has everything, and the page says whether the icon is
   pinned. The card shows a one-time tip pointing to the DevTools version. Tabs that were already open need a reload.

Everything else (the model, what the AI sees, permissions, addresses, your data) is under **Advanced settings**.

The rest of this section sets up the local server.

## Requirements (local server)

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
3. Click **Details → Extension options**, choose **Claude Code**, paste the pairing token, then click **Check connection**.
4. Reload any tab that was already open, so the console capture starts there.
5. Open DevTools (F12). There is a new **AI** tab.

For local `file://` pages, also turn on *Allow access to file URLs* in the extension's details.

### Start the server from the extension (no `npm start` each time)

The **Server** button in the panel's toolbar (F12 and the card, local server mode only) starts and stops the agent
server; when it isn't running, the panel shows **Start server**. A browser extension can't start programs by itself,
so this goes through a small helper that Chrome may start for this extension only (native messaging). Set it up
once, in this folder:

```bash
npm run services:install -- --id <extension id>
```

The extension shows this command with its ID filled in the first time you click Server (and in Options). The first
click also asks for your OK to talk to the helper (the optional `nativeMessaging` permission). The helper
(`server/native-host/host.js`) does three things only: report whether the server is running, start it in the
background (output in `~/.integratedai/logs/server.log`), and stop it (it asks the server to save and exit through
`POST /shutdown`, which needs the pairing token and refuses requests from web pages). `npm run services:uninstall`
removes it; `npm start` keeps working as before.

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
| **Memory** | What the AI remembers about this site (see below): notes and page types, to edit, delete or add to; and whether this conversation uses the shared memory, a private one, or none |

**History** in the toolbar lists earlier conversations on the site.

### The card on the page (toolbar button)

Click the extension's toolbar button (or press **Alt+Shift+A**) to open the **card**: the basic version of the
panel, on the page itself, no DevTools needed. It floats at the bottom right and leaves the rest of the page usable.

- **Move it** by its header. Drag it against the left or right edge (or use the dock button) to make it a
  full-height side panel; drag it away again to float. Edges and corners resize it. Its place is remembered.
- **See-through** (the ◐ button: off / light / strong): floating, it fades whenever the mouse is elsewhere and is
  solid while you point at it. Docked, it **pushes the page aside** instead of covering it: the page gets narrower
  (fixed headers and buttons at that edge are narrowed or moved too), and gets its room back when the card floats,
  is minimised or closes. **—** or **Esc** minimises it to a small pill; **✕** closes it.
- It stays open on the tab's next pages (it comes back after each page load) until you close it.
- **Pick element** chooses the element to ask about (hover outlines it, a click picks it, Esc cancels).

What the card does, and what is DevTools only:

| | Card | DevTools (AI tab) |
|---|---|---|
| Chat, explain, read the page to you, choose provider and model | yes | yes |
| Page outline, text, search, screenshots, console errors | yes | yes (plus "Open source") |
| CSS changes: preview, apply, undo, save as site patch | yes | yes |
| Selecting an element | Pick element | the Elements panel |
| Element edits, forms, agent modes, saved tasks, scripts | **Continue in DevTools** | yes |
| Network log, page resources, iframes | no | yes |

The AI knows it is in the card: asked for something DevTools-only, it says so and points to **Continue in DevTools**.
The card and DevTools share the tab's conversation, so pressing F12 and opening the AI tab continues where the card
was; the card then steps aside ("continued in DevTools"). The orchestrator only offers the card's actions to the
model (`CARD_ACTIONS`) and refuses any other call, and the panel refuses them too.

How it works: the service worker injects `content/card-host.js` into the tab. It builds the card's frame (header,
drag, docking, resizing, fading, the pill) in a closed shadow root, so page CSS can't reach it and the AI's page tools
never see it, and shows `panel/panel.html?card=1` inside, the same panel as in DevTools. Without DevTools, page
functions run through `chrome.scripting` in the extension's isolated world (`callInPage` in `inspected.js`); the
console buffer is read in the page's own world. Chrome's own pages and the Web Store don't allow extensions: there the
toolbar button shows a "!" note instead.

### Memory: what it remembers between conversations

Memory has two layers. In local server mode both are stored by the server in `~/.integratedai/`; in direct mode, in the extension's storage in the browser. Either way they survive browser restarts.

**1. Site memory** (server: `memory/<site>.json`): short notes per site and per **page type**.
- The AI saves notes with the `remember` action when it learns something reusable, such as key selectors (`nav bar: nav.g_nav`), how the site is built, or your preferences (e.g. a dark theme you saved). It fixes wrong notes with `forget`.
- Notes are saved without asking, never touch the page, and show in the chat as **Remembered …**.
- **Whole site** notes apply to every page of the site. **This kind of page** notes apply only to pages of the same page type.
- At the start of each conversation, and whenever the notes change, the AI receives the notes that apply to the current page (`<site_memory>`, a few hundred tokens). So it starts out knowing the site.
- The **Memory** tab shows everything: rename page types, edit, delete or add notes yourself (e.g. *"I prefer serif fonts for reading"*).

**Page types** (path categorisation): long, dynamic URLs are grouped by a path pattern. For example, `/book/lord-of-mysteries_11022733705139605/chapter-1_29558554638401523` becomes **"Chapter reader" = `/book/*/*`**.
- `*` matches one path part (any ID or slug). A final `**` matches anything below.
- An automatic guess replaces ID-like path parts with `*`.
- The AI names page types and fixes patterns with `define_page_group`. You can edit them in the Memory tab.
- Saved patches can also be scoped to a page type: **Save as site patch → "Pages like this: Chapter reader"**.

**2. Conversation history** (server: `conversations/`; direct mode: IndexedDB): every conversation is kept.
- **History** in the toolbar lists the conversations on this site, those about the same page type first. Clicking one continues it (with the Claude Code CLI, its session is resumed too).
- A new conversation on a known site starts fresh but already knows the site memory. It offers **Continue "…"** for the latest conversation on that site, and shows how many things it remembers.

Notes come partly from page content, so they are treated as data, never as instructions. They are only shown for their own site, and you can see and delete every one.

**Conversations are per tab.** They survive closing DevTools, reloads and navigation in the same
tab. After a browser restart a tab starts with a new conversation; earlier ones are under **History**.
Conversations are never merged just because two tabs share an origin. **New** starts a new
conversation for the tab.

## Actions (what the model can do)

Defined once in [extension/shared/actions.js](extension/shared/actions.js) and validated on **both** the server and the panel.

| Action | Kind | Undo |
|---|---|---|
| `find_elements` | read: search the page by selector or visible text (e.g. find the nav bar); page landmarks by default. Each match has a ref (`e12`) that later steps can target | — |
| `page_outline` | read: what's on screen, like a person scanning the page: buttons, links and fields with refs and their state, the focused element, an open dialog, headings, iframes, visible text | — |
| `read_text` | read: the text of the page or one element (headings, lists, tables, field values, text areas such as code viewers), 12,000 characters at a time | — |
| `inspect_element` | read: computed styles, matching CSS rules, ancestors, children, HTML | — |
| `inspect_console` | read: captured console messages | — |
| `inspect_network` | read: DevTools network log, sensitive headers/params redacted, no bodies | — |
| `inspect_resources` | read: page resources, or the source text of one | — |
| `screenshot` | read: an image of an element or of the visible page, so the AI can see colours and layout (shown to you in the chat too) | — |
| `inject_css` | **change**: add a stylesheet (preferred). Optional `toggle`: an on/off button on the page | full (removeCSS) |
| `modify_element` | **change**: styles, attributes, classes or text of one element | full (snapshot restore) |
| `interact` | **page action**: click, hover, type, choose options, tick boxes, submit, scroll, press keys, wait, with real events, one step at a time | typed values, selections and checkboxes yes; clicks and submits no |
| `navigate` | **page action**: open a URL, go back/forward, reload, and wait for the page to load | no |
| `execute_js` | **change**: arbitrary JS. **Off by default.** | only if the model provided `undoCode` (best effort) |

Read-only inspections run automatically unless you enable *"Ask before the AI reads page details"* in Options.

**Doing things on pages (`interact`).** Ask for things like *"register me for SC2005 index 10102 and submit"*, *"change the language to Türkçe and save"* or *"fill in this form with …"*.
- The AI finds the elements and proposes one card listing every step. Nothing happens until you click **Run steps**.
- Steps use real browser events (a pointer/mouse sequence and `click()`; typing through the browser's own "insert text" editing command, which fires trusted `input` events, falling back to the native value setter plus `input`/`change`), so React, Vue, Angular and MUI apps and the rich text editors in chat apps update their state. Setting attributes with `modify_element` doesn't do that.
- Each step waits up to 5 s for its element, so menus that open after a click work.
- A step can target an element by ref (from `find_elements` or `page_outline`: always exactly that element, also among identical rows), by CSS selector, or by its visible text. Open shadow roots are searched too.
- A click on a disabled button fails with a clear message; a click on something covered by a banner or overlay, or on a link that opens a new tab, says so in its result.
- If a step fails, the card says which steps already ran.
- No JavaScript setting is needed.

The system prompt tells the AI who it works for: the browser's owner, who approves every change, so everyday tasks on their own accounts are normal requests.

### Let it work on the page (agent modes)

By default the AI only **suggests**: a click or a page change is a card you run. Pick a mode in the menu at the bottom
left of the message box (or a default in Options → Advanced settings) to let it operate the page itself, step by
step, like Claude Code's permission modes:

| Mode | What happens |
|---|---|
| **Suggest** (default) | Every change is a card; nothing happens until you click. |
| **Ask each step** | It clicks, types, scrolls and opens pages itself, and asks **Allow / Allow all for this task / Deny** in the chat before each step. |
| **Auto** | Steps run on their own. It still asks before **risky** ones: submitting a form, pressing Enter, clicking Send / Pay / Buy / Delete / Post-like buttons, typing into a password field, or going to another site. |
| **Full auto** | Never asks. Only per conversation, after confirming a warning. |

How it works: in the agent modes `interact` and `navigate` run **during** the AI's turn and their result (what was done, and
an outline of the page afterwards: what's on screen with refs to target, and the visible text) goes back to it, so it looks, acts, checks and continues until the task is done
(up to 40 steps per message, `maxAgentSteps`). After each step it waits until the page has settled (a load or route
change finished and nothing re-rendered for half a second), so the AI doesn't need wait steps. Steps can run inside an
iframe (`frame`: the frame's URL, which `page_outline` lists). Before each step the target is outlined on the page with a label
("IntegratedAI: click button "Send""), and the chat lists every step as it happens. While it works, a small
**"IntegratedAI is working on this page ■ Stop"** badge sits in the page's corner (shown again after every page load); it and the
**■** button in the panel stop it at any time.
Style changes, element edits and scripts stay cards in every mode. Page content is treated as untrusted data: the AI
is told never to follow instructions found on pages, and the panel (not the AI) decides what needs your OK.
**Saved tasks.** After an agent turn that did things on the page, the chat offers **Save these N steps as a task**.
The **Tasks** tab lists the tasks for this site: **Run** replays the steps without the AI (free, fast, the same every
time), asking before risky steps as in Auto mode; Stop in the panel or on the page stops it. If the tab is on another
page, the task opens its start page first. Steps are saved with targets that survive a reload (the element's selector,
then its visible name), never with refs, and never with what was typed into a password field (that step is skipped
on replay). Saved steps pass the same checks as the AI's, also when imported from an export file. Tasks are stored
in the browser and included in *Options → Your data → Export*.

With the Claude Code CLI, the page actions are offered as MCP tools (`mcp__page__interact`, `mcp__page__navigate`) in
the agent modes only.

**Screenshots.** The panel captures the inspected tab (`chrome.tabs.captureVisibleTab`) and crops it to the element. An off-screen element is scrolled into view first, and the page is scrolled back afterwards. The image is resized to at most 1280 px and sent as a JPEG, and a thumbnail appears in the chat ("Looked at …"; click it to enlarge).
- **Check it:** an applied or saved change has a **Check it** button. It asks the AI to screenshot the result and propose fixes for anything that still looks wrong, such as areas a dark theme missed or unreadable text.
- The inspected tab must be the visible tab in its window. With DevTools docked it always is.
- Only what's on screen can be captured: an element taller than the window is cut off.
- **Claude Code CLI:** the image comes back from the `mcp__page__screenshot` tool.
- **API providers:** the image goes with the tool result (OpenAI-compatible APIs: as an image in the next user message). Only the last 3 screenshots are re-sent on later calls, because each one costs about 1–1.5k input tokens every time. Some local Ollama models can't see images; **Check connection** says so.

**Web search.** The AI can search the web and read web pages (documentation, MDN, browser support). It is on by default; turn it off in Options.
- **Claude Code CLI provider:** uses Claude Code's `WebSearch`/`WebFetch` tools, and nothing else is enabled.
- **Anthropic API** (server or direct mode): uses Anthropic's server-side `web_search`/`web_fetch` tools.
- **OpenAI, Gemini, OpenRouter, Ollama:** no web search.

### Apply to source (your own websites)

When the page is **your own site**, an applied CSS change can go into the project's real source files: click **Apply to source…** on its card.

1. Claude Code runs in your project folder with **read-only** tools (`Read`, `Glob`, `Grep`). It can't edit anything, and reads outside the folder are denied. It finds where the elements are styled and proposes exact edits that follow the project's conventions: the existing stylesheet, CSS module, Tailwind classes and so on. It drops `!important` and extra selector specificity that were only needed from the outside.
2. The card shows the edits as a diff. **Nothing is written yet.**
3. **Write to files** makes the server apply the edits, but only if the files haven't changed since the proposal. **Undo source edits** restores the originals, even after a server restart, and leaves alone any file you've edited since.

Set it up in `config.json` (see [Configuration](#configuration)) by mapping your site's URLs to its folder:

```jsonc
"projects": [
  { "name": "my-site", "path": "C:\\Users\\you\\code\\my-site", "urls": ["http://localhost:3000", "https://my-site.com"] }
]
```

The button only appears on pages whose URL starts with one of `urls`. If several entries match, the longest prefix wins. Projects can only be set in `config.json`, never from the extension. Files use the line endings they already have (CRLF stays CRLF).

### Toggle buttons (theme switches, reading mode, …)

Ask for something you want to switch on and off from the page itself, for example:
- *"add a toggle in the nav bar to switch between light and dark theme"*
- *"a reading mode button in the header"*

What happens:
1. The AI uses `find_elements` to locate the nav bar and writes the CSS. It proposes `inject_css` with a `toggle`, such as `{ label: "🌙 Dark", activeLabel: "☀️ Light", placeSelector: "nav.g_nav" }`.
2. Apply it, then click **Save as site patch + toggle…**.
3. A real button appears in the nav bar. Clicking it switches the patch on and off, and the choice is remembered across reloads and visits.

The button is created by the extension's own content script (`content/patch-toggles.js`, in an isolated world), not by JavaScript the model wrote, so this works with `execute_js` disabled. If the target element isn't found (e.g. the site changed), the button floats in the bottom-right corner instead.

## Your data: where it lives and what updates do

Everything stays on your computer.

| Data | Where | After an update | After uninstalling the extension |
|---|---|---|---|
| Conversations | server: `~/.integratedai/conversations/` | kept | kept (it's on the server side) |
| Site memory and page types | server: `~/.integratedai/memory/` | kept | kept |
| Server settings, pairing token | server: `~/.integratedai/config.json` | kept | kept |
| Claude Code's own session history | `~/.claude/projects/…claude-cli-workspace/` | kept | kept |
| Saved patches, extension settings | Chrome's storage for this extension | kept | **deleted**: export first |
| Direct mode: conversations, site memory | Chrome's storage for this extension (IndexedDB, `memory:<site>` keys) | kept | **deleted**: export first |
| Tab ↔ conversation map, undo info | Chrome session storage | — | cleared on browser restart by design |

**Updates never lose data:**
- **Server:** the data folder has a version (`data-version.json`). When a new version needs a different format, the server first copies the folder to `~/.integratedai/backups/before-v<N>-<date>/`, then migrates it. If you run an *older* server on *newer* data, it refuses to start rather than damage it.
- **Extension:** Chrome keeps extension storage across updates. The extension stamps it with a version (`storageVersion`) and migrates it in `chrome.runtime.onInstalled`.
- **First install:** the Options page opens automatically so you can add an API key or connect to the server.

**Moving to another copy of the extension.** A development copy (Load unpacked) and the Chrome Web Store version are *different* extensions to Chrome, with separate storage. In server mode your conversations and memory are shared, because they're on the server; your patches are not. In direct mode, nothing is shared.
1. In the old copy, open **Options → Your data → Export**. The file holds your patches and settings, and in direct mode also your conversations and site memory (shared and private).
2. In the new copy, click **Import…**. Importing adds to what's there: a conversation is only replaced by a newer copy of itself, and memory notes are joined without duplicates.

API keys and the pairing token are never exported.

**Options → Your data** shows what's stored on both sides and has **Delete extension data**. To back up or remove the server's conversations and memory, copy or delete its folder.

## Security model

- **Approval:** changes are never executed by the server. The panel runs them only after a click. `execute_js` also requires ticking "I reviewed this code", and its card says whether it can be undone.
- **Agent modes:** only the page actions (`interact`, `navigate`) can run without a card, and only in the mode you picked for the conversation. The panel enforces the mode itself and decides which steps are risky (by looking at the real element, not at what the AI says); Full auto needs an explicit confirmation per conversation and is never a default.
- **Validation:** every action is validated against its JSON Schema by the agent (on the server, or in the panel in direct mode) *and* again in the panel just before it runs, with extra rules:
  - no `on*` event-handler attributes
  - no `javascript:` URLs
  - no `srcdoc`
  - no `<style>` tags inside CSS
  - length limits on all inputs
- **API keys (direct mode):** stored in the extension's storage in this browser, never exported, and each is sent only to its own provider.
- **Server access** (local server mode):
  - The server listens on `127.0.0.1` only.
  - It rejects any Origin other than `chrome-extension://…`, which blocks websites.
  - It rejects non-local Host headers, which blocks DNS rebinding.
  - It requires the pairing token.
  - You can pin your extension ID with `allowedExtensionIds` in the config.
- **Screenshots:** a screenshot shows whatever is on screen in that tab, so it can include personal information the page displays. Like the other inspections, you can require approval for each one in Options. The panel shows every screenshot the AI takes.
- **Network data:** cookies, authorization and API-key headers, and token-like query parameters are redacted. Response bodies are never sent.
- **Model output:** rendered with `textContent` only, never `innerHTML`. Page content is described to the model as untrusted data.
- **Claude Code CLI isolation:** the CLI runs in an empty folder. It gets no file or shell tools. Only `WebSearch`/`WebFetch` can be enabled (via the web search setting), plus this server's own page inspections over MCP. Your own MCP servers are ignored (`--strict-mcp-config`). It also uses `--permission-mode dontAsk`, `--setting-sources ""` and `--disable-slash-commands`. The model can answer, read the page and search the web; it cannot touch your files.
- **Apply to source:** Claude Code only gets read-only tools, and runs in a project folder listed in `config.json`, never one chosen by the extension. The server checks every proposed edit and writes nothing until you click **Write to files**. Edits must stay inside the project (no `..`, no absolute paths, no symlinks leading out, nothing in `.git` or `node_modules`), and the text to replace must appear exactly once. Original contents are kept in `~/.integratedai/source-edits/` for undo.
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
  "maxAgentSteps": 40,                // the same in the agent modes, where each page step is one call
  "projects": [],                     // your own sites' source folders for "Apply to source" (see above)
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
- **Anthropic API:** computed from token usage and the prices in [pricing.js](extension/shared/providers/pricing.js).
- **OpenAI, Gemini, OpenRouter, Ollama:** token counts only (where the API reports them), no cost.

## Project layout

```
extension/                      ← load this folder in chrome://extensions (no build step)
  manifest.json
  shared/                       ← used by BOTH extension and server
    actions.js                  action catalog + schemas + safety validation
    validate.js                 tiny JSON-Schema validator (no dependencies)
    protocol.js                 panel ↔ agent message types (documented)
    url-scope.js, page-groups.js  patch scopes (origin / prefix / glob / page type), URL categorisation
    css-boost.js                makes injected CSS win specificity ties with page rules
    data-transfer.js            Options → Export / Import
  content/card-host.js          the card on the page: its frame, dragging, docking, fading (panel.html?card=1 inside)
  panel/lib/surface.js          DevTools panel or card (IN_CARD, TAB_ID)
    agent/
      orchestrator.js           the turn loop and approval rules (memory modes too)
      requests.js               panel requests, answered the same way by server and direct mode
      system-prompt.js, memory.js, session-model.js, format-result.js
    providers/
      base.js                   the Provider interface
      anthropic.js              Anthropic API (official SDK)
      openai-compatible.js      OpenAI, Gemini, OpenRouter, Ollama (one preset each)
      common.js, pricing.js
  devtools/devtools.{html,js}   registers the "AI" panel
  panel/
    panel.html / panel.css / panel.js   UI controller ("App")
    components/                 <ai-chat>, <ai-action-card>, <ai-patches>, <ai-console>, <ai-memory>, <ai-history>
    direct/                     direct mode: the agent inside the panel, IndexedDB and memory storage
    lib/
      page-scripts.js           functions that run INSIDE the inspected page
      page-interact.js          the interact action's steps (real events)
      inspected.js              inspectedWindow.eval wrappers (approved scripts are awaited)
      context.js                small per-message context ($0, console, network)
      inspections.js            read-only tools (+ header/URL redaction)
      changes.js                apply / preview / undo
      ws-client.js, settings.js, bg.js, dom.js, markdown.js
  background/service-worker.js  tab→conversation map, insertCSS/removeCSS, patches, data export/import
  content/console-capture.js    MAIN-world console/error recorder (document_start)
  content/patch-toggles.js      on/off buttons for saved patches with a toggle
  options/                      settings page
  vendor/anthropic-sdk.mjs      the official Anthropic SDK, bundled (npm run vendor:sdk)
server/
  src/index.js                  HTTP + WebSocket server
  src/auth.js                   Origin/Host checks, token comparison
  src/mcp.js                    POST /mcp: page inspections as MCP tools for Claude Code
  src/connection.js             per-panel socket handling, routing
  src/config.js                 ~/.integratedai/config.json
  src/agent/page-tools.js       per-call tokens and the inspections offered over MCP
  src/source/source-editor.js   Apply to source: read-only Claude Code call, edit checks, write, undo
  src/sessions/store.js         conversations as JSON files
  src/memory/store.js           site memory as JSON files
  src/storage/data-version.js   data folder versions, backups and migrations
  src/providers/
    registry.js                 list of server providers
    claude-cli.js               claude -p provider
    _template.js                start here for a new provider
  test/                         node:test unit tests
store/                          Chrome Web Store kit: privacy policy, listing texts, screenshots
docs/                           public site with the privacy policy (npm run site)
scripts/                        packaging, store screenshots, site and SDK builds
```

## How a turn works

Described for local server mode. In direct mode the same orchestrator runs inside the panel, and the messages
below are passed in memory instead of over the WebSocket.

1. The panel sends `chat.send` with your text and the small context.
2. The orchestrator calls the provider:
   - **Claude CLI** gets `--json-schema` for the `{ reply, actions[] }` envelope and `--session-id`/`--resume`, so one Claude Code session is kept per conversation. It also gets `--mcp-config` pointing at this server's `/mcp` endpoint, so the inspections are real tools (`mcp__page__find_elements`, …) it can call while it works.
   - **API providers** (Anthropic, OpenAI-compatible) get the actions as native tools.
3. Inspections are sent to the panel (`tool.request`), run in the page, and their results go back to the model. With the Anthropic API, and with Claude CLI inspections listed in `actions`, this loops up to `maxStepsPerTurn` times. Claude CLI's MCP tool calls are answered inside the same call.
4. Changes are sent as `action.proposed` and nothing more happens. When you apply, reject, undo or save, the panel reports it (`action.status`). The model receives your decision as the tool result at the start of your next message, so it knows what actually happened.

## Adding a provider

- **A service with an OpenAI-compatible API** (Groq, Mistral, LM Studio, …): add one preset to `PRESETS` in
  [openai-compatible.js](extension/shared/providers/openai-compatible.js), add it to `DIRECT_PROVIDERS` in
  [direct-client.js](extension/panel/direct/direct-client.js) and to the provider list in Options, and name the
  service in `store/PRIVACY.md`.
- **Anything else:** copy [server/src/providers/_template.js](server/src/providers/_template.js) and implement
  `checkAvailability()` and `turn()`, which yields `text_delta` / `tool_call` / `usage` / `done` events. For the
  server, add the class to `PROVIDERS` in [registry.js](server/src/providers/registry.js); for direct mode, put it in
  `extension/shared/providers/` (no Node APIs) and add it to `DIRECT_PROVIDERS`.

Approval, validation, page inspection and storage are handled for every provider by the orchestrator.
Providers with function calling pass `ACTIONS[name].inputSchema` directly as tool parameters; providers without
tool calling can reuse `envelopeSchema()` like the CLI provider does.

## License, and supporting it

Copyright (C) 2026 Alp Kavaklı

IntegratedAI is free software: you can redistribute it and/or modify it under the terms of the
[GNU Affero General Public License](LICENSE) as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the license for
more details.

In plain words: use it, change it, share it, even sell it; but whoever publishes a copy or a changed version (an
extension, or the agent server run as an online service for others) must share its full source under the same license.

Bundled third-party code keeps its own license: the vendored Anthropic SDK is MIT
(`extension/vendor/anthropic-sdk-LICENSE.txt` ships with the extension), as is the `ws` package the server uses.

Wanna donate? We'll use the money to buy more AI credits, duh. (A Donate link appears at the bottom of the setup page
once `DONATE_URL` in `extension/options/options.js` points to a donation page.)

## Planned extensions (and where they plug in)

- **Persistent JS patches:** deliberately left out; they need a stronger review flow.

## Tests

```bash
npm test
```

127 unit tests cover:
- action validation and safety rules
- auth (Origin, Host, token) and patch scopes
- CLI argument building and output parsing, including session resume, cost differences, recovery from a lost session, decoding the streamed reply, enabling only the web tools and our MCP page tools, and the one-time correction when a model calls page actions as tools
- Anthropic message and tool conversion
- the orchestrator: inspection round-trips, proposals, decisions reported as tool results, disabled `execute_js`, usage, persistence
- the MCP endpoint: only inspections are listed, calls reach the right conversation, inputs are validated, and tokens, Origin and Host are checked
- screenshots: images are split out of results (never sent as text), invalid ones dropped, returned as MCP image content, and sent to the Anthropic API as images, only the most recent few
- Apply to source: exact unique replacements, new files, CRLF files, paths kept inside the project (including through symlinks), project matching by URL, propose → write → undo (also after a restart), refusing files changed in between, and the read-only Claude Code arguments
- site memory and page types: URL categorisation, note scopes, renaming groups, memory sent only when it changes, history per site, and shared / private / no memory per conversation
- direct mode: the shared request handler, provider choice, and the OpenAI-compatible providers (streamed tool calls, cut-off answers, readable errors for bad keys, Ollama's address, missing server and refused origin)
- export / import (no secrets, version 1 files, merging conversations and memory), data folder versions and backups
- action validation including refs, frames, `page_outline` and `read_text`; strict Anthropic tool schemas kept within the API's budget (24 optional parameters per request)
- saved tasks: recording (refs become selectors with the visible name as fallback, no password values), export /
  import, and refusing tampered steps
- agent modes: which actions run live, denied steps, more steps per turn, Full auto never a default, the new steps and navigate, MCP tools only in agent modes
- CSS boosting, screenshots re-sent only for the last 3, and approved scripts that use `await` (timeouts, reloads)

**UI check:** `npm run ui-check` opens the panel and the setup page in headless Chrome against a scripted stand-in
AI (no key, no cost), saves a screenshot of each state, and runs an accessibility audit (axe-core, WCAG 2 A/AA)
plus layout checks. It exits with 1 on any problem.

**Page check:** `npm run page-check` runs the in-page code (finding, refs, outline, text reading, clicking, typing,
waiting for the page to settle) in headless Chrome on a test page with what tripped the agent up on real sites:
rows of identical markup, a code viewer's text area, shadow DOM, an overlay, a disabled button, a modal dialog, a chat
composer that only trusts real input events, a new-tab link and an iframe. No AI, no extension.

These were also checked against real Chrome and the real `claude` CLI during development:
- page scripts and console capture
- `insertCSS`/`removeCSS` under a strict CSP
- automatic patch reapplication
- the full panel UI flow: preview, apply, undo, save patch, toggle patch, Explain
- Claude Code (Sonnet) calling the page inspections over MCP: through the real server on a new and a resumed session, and with the real panel code in Chromium on a webnovel-like test page (the panel ran in a tab with a `chrome.devtools` stand-in). There, "Make a toggle button in the nav bar…" found `nav.g_nav`, and Apply, Save as site patch + toggle, reload and the toggle all worked.
- screenshots with the real panel code in Chromium: of the nav bar, and of a footer 2,400 px below the fold. The page was scrolled to the footer and back, and Sonnet read both images correctly.
- Apply to source end to end in Chromium with Claude Code (Sonnet) on a small test project. It changed the existing `.main-nav` rules instead of pasting the browser CSS, wrote only after the click, and Undo restored the file.
- direct mode in Chromium with recorded-style API answers (Anthropic, OpenAI), the key check against the real APIs with invalid keys, Ollama against a stand-in server with Ollama's origin rules, and export / import / delete of the stored data. **Not yet done: direct mode with real API keys.**
- a real Ollama (0.35, `qwen3:8b` on an 8 GB RTX 4060, 16K context) driven through the real panel in Chromium: a CSS
  fix in Suggest mode (16 s), filling in and submitting the demo sign-up form in Auto mode with the risky submit
  asked first (51 s), and summarising the blog page (10 s).

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
- Injected CSS beats ordinary page rules: before inserting, every selector gets `:not(#integratedai)` added, which matches everything but counts as one more ID (`extension/shared/css-boost.js`). Cards and patches still show the CSS as the AI wrote it. Page rules with `!important`, inline styles and selectors with two or more IDs can still win; the AI uses `!important` for those.
- The card on the page can't open on Chrome's own pages or the Web Store, and has no iframe, network or resource tools.
- CSS patches, `modify_element`, screenshots and the selected-element context are top-frame only. The AI can look into
  and operate iframes (`find_elements`, `page_outline`, `read_text`, `inspect_element`, `interact` with `frame`).
- Console capture starts when the page loads; tabs opened before installing the extension need a reload.
- `execute_js` results are awaited for up to 30 seconds; a script that takes longer keeps running in the page, but its result isn't reported.
- Undo info is tied to one page load: after a reload or navigation the page is fresh, so earlier cards show as no longer active.
- The page controls its own JS environment and could tamper with data returned to the panel. That only affects what the AI sees, never what gets executed without your click.
- Agent modes act through the page's DOM with synthetic events (`isTrusted` is false): most sites accept them, a few ignore them. They can't use closed shadow roots, canvas-drawn apps, file pickers, drag and drop, or captchas. Pages that never stop changing (a clock, a live feed) make each step wait up to 3 s (8 s after a page change) before the AI looks again.
