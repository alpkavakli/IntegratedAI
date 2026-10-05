# Chrome Web Store submission kit

Everything the Developer Dashboard asks for, ready to paste. Build the upload with `npm run package`
(writes `dist/integratedai-<version>.zip` after checking the manifest against store rules).

## Store listing

**Name:** IntegratedAI DevTools

**Summary (from the manifest, ≤ 132 chars):**
AI panel in Chrome DevTools: explains layout and console errors, previews CSS fixes, fills forms, saves per-site patches.

**Category:** Developer Tools

**Language:** English

**Description:**

> An AI assistant inside Chrome DevTools. Select an element in the Elements panel, switch to the **AI** tab and
> ask: "why is this overflowing?", "make this look better", "add a dark-mode toggle to the nav bar".
>
> - **Understands the page you're inspecting:** the selected element, its styles, matching CSS rules, console
>   errors, network requests and screenshots.
> - **Proposes, you approve:** every change is a card you preview, apply or undo. Nothing runs on its own.
> - **CSS fixes and themes**, saved as per-site patches with optional on/off buttons on the page.
> - **Does things for you:** fills in forms, chooses options and clicks through flows with real browser events.
> - **Agent modes:** let it work through a task on the page by itself, step by step while you watch. It asks before
>   each step, or only before risky ones (submitting, sending, paying, deleting); you choose.
> - **Remembers each site:** key selectors and your preferences, so the next conversation starts informed.
> - **Explains console errors** and jumps to the source.
> - **Your key, your choice:** paste an API key for Anthropic (Claude), OpenAI, Google Gemini or OpenRouter and go,
>   or use free local models with Ollama.
>   It talks straight to that provider; conversations and site memory stay in your browser. No account with us,
>   no tracking.
> - **Separate memories:** keep a conversation's notes private to it, or share them across the site.
>
> Developers can instead run the free local agent server to use a Claude subscription through Claude Code
> and move CSS into their own project ("Apply to source"): https://github.com/alpkavakli/IntegratedAI

**Screenshots (1280×800), ready in `store/screenshots/`**, upload in this order:
1. `01-diagnose.png`: ask why a badge is cut off; cause plus a previewed fix
2. `02-theme-toggle.png`: a dark reading theme with an on/off button in the site's nav bar
3. `03-forms.png`: Auto mode: it filled in a sign-up form by itself and asks before submitting (the button is outlined on the page)
4. `04-memory.png`: the Memory tab (what it learned about the site)
5. `05-options.png`: connection choice (your own API key or Ollama, or the local server)

They come from real use of the extension on original demo pages (`store/demo-pages/`). Regenerate after UI
changes with `node scripts/store-screenshots.mjs` (needs Chrome and a logged-in Claude Code; makes a few real
AI calls), or a single one with e.g. `node scripts/store-screenshots.mjs 03-forms`.

**Small promo tile (440×280):** `store/screenshots/promo-tile-440x280.png` (from `store/promo-tile.html`, regenerate with
`node scripts/store-screenshots.mjs promo-tile`). The 128×128 icon is `extension/icons/icon128.png`.

## Privacy practices tab

**Single purpose:**
> An AI assistant in Chrome DevTools that helps the user understand and change the web page they are
> inspecting: explaining layout, styling and console errors, proposing CSS, element and form changes, and,
> only when the user turns on an agent mode for a conversation, operating that page for them (clicking, typing,
> opening pages) with the confirmations the user chose.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings, API keys or pairing token, and CSS patches locally, and per-tab conversation/undo state. In direct mode also the site memory notes (conversations are kept in the extension's IndexedDB). |
| `scripting` | Inserts and removes the CSS changes the user approved (`insertCSS` / `removeCSS`), including saved per-site patches. |
| `webNavigation` | Detects when a page the user saved a patch for starts loading, to reapply that patch. |
| Host permission `<all_urls>` | The tool works on whatever page the user is inspecting in DevTools, so it must be able to read that page (on request), capture its console errors, take screenshots, and apply approved CSS on any site. |
| Content scripts on `<all_urls>` | `console-capture.js` records console errors on the page so the AI can explain them; `patch-toggles.js` shows on/off buttons for patches the user saved with a toggle. Neither sends data anywhere. |
| Remote code | **No.** All code is in the package. The AI's suggestions are data; optional user-approved scripts run via DevTools' `inspectedWindow.eval`, never fetched from a server. |

**Data usage disclosures** (check these in the form):
- Website content: **yes**, only on pages the user inspects, sent to the AI provider the user chose (Anthropic,
  OpenAI, Google or OpenRouter) with the user's own key (direct mode), to Ollama on the user's own computer, or to
  the user's local server.
- Authentication info: the user's own API keys are stored locally and each is sent only to its own provider
  to authenticate their requests (declare it if the form asks; never sent to the developer).
- Web history, personally identifiable info, authentication info, financial/health data, personal communications,
  location, user activity: **no** (not collected; sensitive headers are removed before anything is sent).
- Certify: not sold to third parties; not used for unrelated purposes; not used for creditworthiness/lending.

**Privacy policy URL:** https://alpkavakli.github.io/IntegratedAI/privacy.html
(GitHub Pages from `/docs` on `main`; rebuild with `npm run site` after changing `store/PRIVACY.md`, then push.)

## Before each release

1. Bump `version` in `extension/manifest.json` (the store rejects re-uploads of the same version).
2. `npm test`, then `npm run package`.
3. If stored data changed shape: add a migration (server: `server/src/storage/data-version.js`,
   extension: `STORAGE_MIGRATIONS` in `background/service-worker.js`).
4. Upload `dist/integratedai-<version>.zip` in the Developer Dashboard.
