# Handoff: IntegratedAI (Chrome DevTools AI panel)

_State as of 2026-10-06 (second session: better agent clicking and reading). For the next chat (or person) continuing this project. Start here; the README has the
full user-facing documentation._

## What it is

A Chrome extension that adds an **AI** tab to DevTools. You select an element and ask ("why is this overflowing?",
"add a dark-mode toggle to the nav", "fill in this form"). The AI inspects the page and **proposes** changes as
cards (CSS, element edits, clicks/typing, optional JS) that run when you approve them. In the **agent modes** it
can also operate the page itself, step by step (see below).

The goal is to **publish it on the Chrome Web Store**. Everything for that is ready except the owner's upload and
two decisions (see "Open decisions").

## Where things stand

- **Works and is tested:** 127 unit tests pass; `npm run ui-check` (real Chrome, no AI) finds no accessibility or
  layout problems; `npm run page-check` (the in-page code on a tricky test page in real Chrome) passes;
  `npm run package` builds the store zip (54 files, ~227 KB).
- **Store kit is current:** privacy policy (live, describes the agent modes), listing texts, 5 screenshots and the
  promo tile in the current plain UI.
- **Tried with a real model:** the Claude Code CLI (owner's login), including agent mode on the demo form,
  Wikipedia (search → Enter → read the article) and Hacker News (follow "More" → read page 2).
- **Never tried with a real model:** direct mode with a real API key (Anthropic, OpenAI, Gemini, OpenRouter), and
  a real Ollama. Only recorded-style answers, a stand-in Ollama and real bad-key checks.

## Two ways it runs (same agent code)

| | Direct mode (default for new installs) | Local server mode (the owner's setup) |
|---|---|---|
| AI | User's own key: Anthropic, OpenAI, Gemini, OpenRouter; or Ollama (local, no key) | Claude Code CLI (Claude subscription), or an Anthropic key |
| Agent runs | Inside the DevTools panel | `npm start` → Node server on 127.0.0.1:7823 |
| Conversations, memory | IndexedDB, `chrome.storage.local` | `~/.integratedai/` (versioned, with backups) |
| Extras | — | Apply to source; page tools as MCP tools for Claude Code |

## Agent modes (the newest feature, most of the open work)

Chosen per conversation in the menu inside the input box; the default is set in Options → Advanced settings.

| Mode | Behaviour |
|---|---|
| Suggest (default) | Every change is a card; nothing happens until the user clicks. |
| Ask each step | `interact` and `navigate` run during the turn; the panel asks Allow / Allow all for this task / Deny before each step. |
| Auto | Steps run on their own; the panel still asks before risky steps (submit, Enter, Send/Pay/Delete-like buttons, password fields, another site). |
| Full auto | Never asks. Per conversation only, after a warning banner; never a default. |

How it fits together:
- `shared/actions.js`: `AGENT_MODES`, `pageAction: true` on `interact` and `navigate`, `runsLive(name, mode)`.
  `interact` steps: click, type, select, check, uncheck, submit, scroll, press, wait.
- `shared/agent/orchestrator.js`: live page actions are sent to the panel during the turn (`requestTool`), the result
  goes back to the model, up to `maxAgentSteps` (40) model calls per message. Records get `live: true`.
- `shared/agent/system-prompt.js`: the "Working on the page yourself" section (only in agent modes).
- `server/src/agent/page-tools.js`: with Claude Code, the page actions are MCP tools in agent modes only.
- `panel/lib/agent-runner.js`: per step: dry run (find, outline on the page, describe, classify risk) → ask if the
  mode says so → short pause → do it → wait for page loads. Retries 2 s for elements that re-render.
- `panel/lib/page-interact.js`: the steps inside the page, risk detection (`riskOf`), the outline (held while
  asking), `quietFor` (how long the page has been unchanged), and the "working… Stop" badge (closed shadow root).
- `panel/lib/page-scripts.js` → `pageHelpers()`: `refOf`/`byRef` (element refs like `e12`, kept in the page's hidden
  state until reload), `cssPath` (unique selectors: stable attributes first, then a path long enough to tell table
  rows apart), `queryAll` (pierces open shadow roots), `humanName`, `readable` (text as a person sees it).
  `pageOutline` and `readText` are the `page_outline` / `read_text` inspections.
- After each step the runner waits until the page is quiet (load done, no DOM changes for 0.5 s; gives up after 3 s,
  8 s after a page change) and returns `pageOutline` (40 elements, 1,200 chars of text) instead of just URL/title.
- Frames: `frame` (an iframe's URL) on find_elements, page_outline, read_text, inspect_element and interact;
  `callInPage(fn, args, frame)` passes it as `inspectedWindow.eval`'s `frameURL`.
- **The panel enforces the mode itself** (never runs page actions in Suggest mode) and decides risk on the real
  element, not from what the model says. Style changes, element edits and scripts stay cards in every mode.

## Open decisions (ask the owner)

1. **`execute_js` and store review.** It runs AI-written code in the page (off by default, only after the user ticks
   "I reviewed this code"). Store policy forbids executing remotely hosted code; a reviewer may count model-generated
   code as that. **Decided (2026-10-06): keep it in the store version.** The policy exempts code run in contexts isolated
   from extension APIs, and `inspectedWindow.eval` runs in the page's own context; store/SUBMISSION.md has the
   "Remote code: Yes" justification to paste. Fallback only if review rejects it: a store build without it.
2. **Trusted input for agent mode.** Synthetic events have `isTrusted = false`; most sites accept them, a few ignore
   them. Real input needs the `debugger` permission, which shows users a scary warning and hurts store review. Only
   worth it if real sites (Telegram Web etc.) turn out to ignore our events.

## Done in the second session (2026-10-06)

Prompted by a real run on GitHub (Full auto, Claude Code), where the AI added "wait 3 s" after every click, got the
same selector for every file row, and couldn't read a file because the code was in a text area:
- **Refs** (`e12`) from find_elements / page_outline, usable in interact steps (`ref`); unique selectors for rows.
- **`read_text`** (new inspection): the page or an element as text, incl. text area values, tables, shadow DOM.
- **`page_outline`** (new inspection) and the same outline returned after every step (the old next-work item 2).
- **Settling** after each step instead of fixed sleeps; the prompt tells the AI not to add wait steps.
- **Clicks:** `hover` step; disabled buttons fail clearly; covered elements and new-tab links are reported; when
  text matches several elements the result says so. **Typing** uses `execCommand("insertText")` (trusted `input`
  events, what chat composers listen to), falling back to the old native-setter path.
- **iframes** for agent steps and reading (see above). CSS patches/screenshots stay top-frame only.
- **Bug found and fixed:** Anthropic strict tool schemas allow 24 optional parameters per request in total; we sent
  every tool as strict (35 optional even before today), so direct mode with an Anthropic key would most likely
  have failed on the first message with "Schema is too complex for compilation". `toAnthropicTools` now makes the
  changes strict first and stops at the budget (tested). Still needs the real-key test to confirm.
- Privacy policy: mentions page text/outline and frames, and that password values are never read (also enforced).

Not yet tried with a real model: the new tools and refs. A Claude Code run on the demo pages (store-screenshots
harness) or the owner's GitHub/Telegram test is the next thing to do.

## Done in the third session (2026-10-06)

- **Real Ollama** (qwen3:8b, RTX 4060): works end to end; setup docs now include `OLLAMA_CONTEXT_LENGTH`.
- **Short prompts for Ollama** (Options, off by default): ~2,800 instead of ~6,600 tokens of instructions and tools.
  Measured: at 16K context qwen3:8b did the form task better with the full prompt (2/2 vs 1/2), so it is only for
  small context windows. Found along the way and fixed: models copied the example ref "e12" (no literal example
  refs in prompts now), invalid steps/inspections showed as running or as if they ran (now "not run: why"), null
  optional fields (normalizeInput), and a turn stops after 4 all-invalid model calls in a row.
- **Saved tasks**: "Save these N steps as a task" after an agent turn; Tasks tab with Run / Rename / Delete; replay
  without the AI in `AgentRunner.replay` (Auto-mode asks, Stop works); `recordStep` stores selector + visible-name
  targets and no password values; `validateTaskSteps` checks saved/imported steps; export format v3 includes tasks.
  ui-check saves and replays a task.

## Done in the fourth session (2026-10-06): the card on the page

- Toolbar button / Alt+Shift+A opens the **card**: the same panel.html in card mode (`panel/lib/surface.js`
  IN_CARD), in a frame built by `content/card-host.js` (closed shadow root). Floats bottom-right; drag the header,
  drop at the left/right edge = full-height side panel; resize edges/corners; ◐ see-through off/light/strong;
  minimise to a pill (also Esc); close. Layout in storage.local `cardLayout`; open/minimised per tab in
  storage.session `card:<tabId>`; re-injected on each page load (webNavigation.onDOMContentLoaded).
- Basic feature set (owner's decision): `CARD_ACTIONS` in shared/actions.js, enforced by the orchestrator
  (`surface: 'card'`, always Suggest, prompt section "The card on the page") and the panel. The orchestrator now
  refuses any tool call that wasn't offered this turn (`checkCall`).
- Page access without DevTools: `callInPage` → chrome.scripting in the isolated world (page-scripts.js and
  page-interact.js are web_accessible_resources, dynamically imported there); console functions in MAIN.
  Pick element (`pickElement`) replaces $0. Screenshots hide the card for the capture.
- "Continue in DevTools" explains F12 → AI tab (extensions can't open DevTools); the DevTools panel tells the card
  to step aside (`card.devtoolsOpened`), and the card reloads its frame when brought back.
- Tested: ui-check (float position, page stays usable, Pick element with real mouse input, CSS preview, drag to dock,
  back after reload, Esc, pill, DevTools handoff, axe), page-check (the card is invisible to page tools), and the card
  on the real GitHub and Wikipedia pages (strict CSP) in headless Chrome.

## Done in the fourth session, part 2: the Server button

- Toolbar **Server** toggle (F12 panel and card, local server mode only) and **Start server** in the
  "isn't running" banner. Through native messaging: `server/native-host/host.js` (status / start / stop only),
  registered with `npm run services:install -- --id <id>` (`scripts/services.mjs`: launcher + manifest in
  ~/.integratedai/native-host, HKCU registry keys for Chrome/Chromium/Edge, folders on macOS/Linux).
  `nativeMessaging` is an optional permission, requested on the first click (Options has the same button).
  Stop = `POST /shutdown` (token, no Origin) so conversations are saved; then the started PID as a fallback.
- Gotcha: in the helper, use node:http with agent:false, not fetch: exiting with fetch's open connection crashes
  Node on Windows (libuv assertion, exit 0xC0000409).
- Tested end to end in headless Chrome (Chrome → helper → server, start/stop, the shutdown endpoint refusing no
  token / wrong token / a web page). The owner's Chrome is registered for the extension ID
  chmojffncgjblieclbphmeebjgkoklnd (the unpacked `extension` folder).

## Done in the fifth session (2026-10-06): onboarding, license, store screenshots

- Setup page: choices grouped (easiest: API key, Gemini free tier / free and private: Ollama / for developers);
  Ollama commands per OS with Copy buttons; the check also flags a too-small Ollama context (api/ps, when loaded).
  Step 3 "Start using it": the card (real shortcut from chrome.commands, **Try it now** → Wikipedia with the card,
  service-worker `card.tryIt`), F12 → AI, pinned or not (action.getUserSettings).
- Card: one-time tip about the DevTools version (setting `cardTipSeen`); icon-only toolbar below 480px.
- Saved tasks name form fields by their label (readable steps, sturdier replay).
- License: **AGPL-3.0-or-later** (owner's choice, after MIT and GPL; the MIT version was never pushed). LICENSE is the
  official text (also in the package as extension/LICENSE.txt); the SDK's MIT license file ships next to it
  (vendor-sdk.js copies it); "license": "AGPL-3.0-or-later" in package.json. Donation line at the bottom of the setup page, hidden until `DONATE_URL` is set
  (owner hasn't chosen GitHub Sponsors / Ko-fi / … yet); its × hides it for good (setting `donateDismissed`).
- Store screenshots now: 01-card, 02-theme-toggle, 03-forms, 04-tasks, 05-options (real Claude Code answers).

## Done in the sixth session (2026-10-06)

- Provider menu: a "Switch connection" group (direct ⇄ local server) so choosing Ollama doesn't hide Claude Code.
- Ollama: Unload button (POST /api/generate keep_alive 0) to free the GPU; setup steps for Windows/macOS/Linux.
- Setup page: "Write to the creator: alpkavakli@gmail.com" (owner's professional address, on request).
- Card fixes: Server button (bg() sent the argument over the command name), fading by mouse only, docking pushes
  the page aside (html margin + fixed edge elements, restored on float/minimise/close).

## Done in the seventh session (2026-10-07)

- **DeepSeek, Qwen, Kimi, GLM, MiniMax** presets (ids from each provider's docs, 2026-10-07). They are thinking
  models: `reasoning_content` is captured from the stream into the assistant message's `raw` and sent back to the
  same provider (`sendReasoning`; DeepSeek answers 400 without it); tool-call messages from other providers get "".
  `addressHint` presets (Qwen workspace URL; Kimi/GLM/MiniMax mainland-China URLs) have an API address field.
  **Not yet tried with real keys.**
- **Custom** preset: any OpenAI-compatible service (address required, key optional, any model).
- **Model lists:** Options → Check remembers GET /models per provider (`settings.modelLists`), the panel refreshes
  it at most daily (`refreshModelList`) and updates the live direct config; the model menu = suggestions + listed.

## Next work, in order

0. **Chinese models (owner's next request):** providers like DeepSeek, Qwen (DashScope / Alibaba Cloud Model Studio),
   Kimi (Moonshot), GLM (Zhipu) and MiniMax that use the same tools and can navigate. Most offer OpenAI-compatible
   Chat Completions with tool calls, so they can be presets in `shared/providers/openai-compatible.js` (base URL,
   models, key page) plus a privacy-policy line for each endpoint. Check each one's tool-calling quality with the
   real-model harness (the Ollama runs this session show how), and whether compact mode helps.


1. **Agent mode on real, logged-in apps** (the owner's wish: "let it browse Telegram"). Try Telegram Web and a shop
   or two with Claude Code in Auto mode; fix what breaks. Likely areas: virtualised lists (the `scroll` step),
   contenteditable composers (`type` sets textContent; Enter is sent as key events), risky-word list in `riskOf`,
   the prompt section. How to test: see "Testing agent mode on a real site" below.
2. **Outline tuning: partly done (2026-10-07).** Measured ~900–1,450 tokens/step on GitHub, Wikipedia, HN, BBC; now
   main content first, short link targets, no generated class names, and change-only outlines on the same page
   (`outlineChanges` in agent-runner.js). Still open: whether the visible text (1,200 chars) is worth it per step,
   checked with a real model on a long task.
3. **Real-key test of direct mode** (needs the owner's key): Anthropic first, then OpenAI/Gemini/OpenRouter.
   Ollama is done (2026-10-06): `qwen3:8b` on the owner's RTX 4060 passed a CSS fix, the sign-up form in Auto mode
   and a page summary. Found on the way: Ollama's default context (4,096 tokens) is smaller than our instructions and
   tools (~6,500), so it silently cut them off; the setup page and README now say `OLLAMA_CONTEXT_LENGTH=16384`. The
   owner's PC has no page file (commit limit = RAM), so loading the model failed until Chrome tabs were closed;
   "unable to allocate CUDA_Host buffer" from Ollama means that. Model id suggestions are in
   `shared/providers/openai-compatible.js` (`PRESETS`, checked 2026-10-05); Test key lists what a key can use.
4. **Upload** (owner): developer account, then store/SUBMISSION.md step by step.
5. **Owner's new feature idea, NOT to be built yet (discussion pending):** make the agent "untraceable and human-like"
   and "hidden on normal screen shares". Talk it through with the owner first. Open points raised so far:
   - What it is for decides the design. Human-like pacing so fragile sites keep up is fine; hiding automation from
     sites' bot detection, or hiding the AI from people watching a shared screen (interviews, exams, meetings), is
     deception aimed at third parties, and the AI working on this project should not build that part.
   - A Chrome extension can't hide itself from screen capture at all; only a native app can (OS-level capture
     exclusion), which is outside this project.
   - The Web Store reviews for deceptive behaviour, and the on-page outline and Stop badge exist on purpose so the
     user always sees what the AI does.
6. **Later / ideas:** iframes for CSS patches and screenshots; other providers in server mode; persistent JS patches (deliberately left out for safety); patches applied earlier than navigation commit.

## Known issues and limits

- The panel only works while DevTools is open; the network log only covers requests since DevTools opened.
- CSS patches, element edits and screenshots are top-frame only; closed shadow roots, canvas apps, file pickers,
  drag and drop and captchas are out of reach for agent steps.
- Saved patches can show the page's original style for a moment on fast pages.
- Undo info is per page load. The full list is at the end of the README.

## Commands

```bash
npm install
npm test                                   # 127 unit tests (node:test)
npm start                                  # local agent server (Claude Code)
npm run package                            # store checks + dist/integratedai-<version>.zip
npm run site                               # docs/ (privacy page) from store/PRIVACY.md
npm run ui-check [-- <folder>]             # panel + setup page in headless Chrome: screenshots, axe-core, layout,
                                           # an Auto-mode scenario and the page Stop; no AI, no key
npm run page-check                         # in-page code (refs, outline, read_text, clicks, typing, settling)
                                           # on a tricky test page in headless Chrome
node scripts/store-screenshots.mjs [name]  # store screenshots (real Claude Code calls, ~$0.25; needs Chrome)
npm run vendor:sdk                         # rebuild extension/vendor/anthropic-sdk.mjs after upgrading the SDK
```

Load the extension from `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
**Reload it there after every change.**

## How things are tested

- **Unit tests** in `server/test/`: actions and validation, orchestrator (incl. agent modes), providers, memory,
  export/import, data versioning, MCP page tools, approved scripts, CSS boost.
- **Real Chrome without AI:** `npm run ui-check`. The AI panel runs in a tab with a small `chrome.devtools`
  stand-in that forwards `inspectedWindow.eval` to the real page over the DevTools protocol; a scripted stand-in
  Ollama answers. **Run it after every UI change and look at the screenshots** (it prints the folder): the axe
  audit can't see layout, and a layout bug once slipped past it.
- **Real Chrome with Claude Code:** `scripts/store-screenshots.mjs` drives the real server and CLI on the demo
  pages in `store/demo-pages/`. Its `openScenario()` is the harness to copy.

### Testing agent mode on a real site

Copy `scripts/store-screenshots.mjs` to a scratch file and replace `SCENARIOS` with one scenario that: opens a
real URL in `openScenario()` (let it accept a full URL; pick the newest tab with that URL, `findLast`), sets the
mode with `#agent-mode` (value `auto`) and a `change` event, sends the task via `#prompt` + `requestSubmit()`, then
loops: when `.ask-step` appears, log its text and click its "Allow" button; stop when `#send` no longer has the stop
state and nothing is thinking; finally print `#chat`'s `innerText` and capture panel and page. Headless Chrome has no
logins, so logged-in apps need the owner's own Chrome (load unpacked, try it by hand, send back the chat).

## Rules the owner set (keep them)

- **Simple for users:** setup in about two minutes, settings in plain words.
- **Plain look, not "AI product":** the DevTools greys with one blue accent, 1px borders, small corners, no
  gradients, glows, sparkles or emoji, line icons. The owner asked for this explicitly. Icon: `store/icon.svg`
  (rendered to `extension/icons/`), the DevTools "select an element" mark.
- **Commits are authored only by the owner** (Alp Kavaklı, alpkavakli@gmail.com). No `Co-Authored-By` or other
  attribution lines: `git -c user.name="Alp Kavaklı" -c user.email="alpkavakli@gmail.com" commit …`.
  **Commit, don't push**: the owner pushes and likes to run git commands themselves.
- **Plain modern JavaScript** (ESM, JSDoc, `// @ts-check`), no TypeScript, no build step for the extension (the
  vendored SDK is the one exception). Readable, commented code that matches the surrounding style.
- **Store-ready:** minimal permissions (storage, scripting, webNavigation, `<all_urls>`), no remote code, an
  accurate privacy policy (update `store/PRIVACY.md` and run `npm run site` whenever behaviour or data handling
  changes), `npm run package` passing.
- **Approval model:** in Suggest mode nothing changes the page without the user's click. Agent modes may run
  `interact`/`navigate` within the mode's rules; style changes, element edits and scripts always wait for a click.
  Inspections and memory notes run on their own (visible in the chat).

Declined earlier, and why: changing the prompt to make the AI do graded coursework, or to override its judgement
about reproducing copyrighted text. The prompt tells the AI who it works for; for copying text the panel has a
**Copy text** button that works without the AI.

## Repo and working notes

- Work on `main` (`origin` = github.com/alpkavakli/IntegratedAI, **public**). Other (remote) chats have pushed
  their work to their own `claude/…` branches; check `git branch -a` and fast-forward `main` if one is ahead.
  `claude/gifted-einstein-uiuf7u` is fully merged and can be deleted; so can the local `backup/before-author-fix`.
- GitHub Pages serves `/docs` from `main`: https://alpkavakli.github.io/IntegratedAI/privacy.html
- This checkout uses **CRLF** in the working tree (the repo stores LF, `core.autocrlf=true`). Scripted edits that
  assume LF silently miss; normalise line endings when editing by script, or use a plain editor.
- Python isn't installed on the owner's machine; Node is. Chrome is at
  `C:/Program Files/Google/Chrome/Application/chrome.exe` (override with `CHROME_PATH`).
