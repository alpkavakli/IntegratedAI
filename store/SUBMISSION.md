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
> - **Remembers each site:** key selectors and your preferences, so the next conversation starts informed.
> - **Explains console errors** and jumps to the source.
> - **Private by design:** works through an agent server on your own computer and the AI account you choose.
>
> Requires the free IntegratedAI agent server (Node.js) and a Claude account or API key. Setup:
> https://github.com/alpkavakli/IntegratedAI

**Assets you still need to make:**
- Screenshots: 1280×800 (or 640×400), 1–5 of them. Suggested: chat with an inspection card, a CSS proposal
  with preview, the dark-mode toggle on a page, the Memory tab, the Options page.
- Small promo tile: 440×280 (optional).
- The 128×128 icon is in `extension/icons/icon128.png`.

## Privacy practices tab

**Single purpose:**
> An AI assistant in Chrome DevTools that helps the user understand and change the web page they are
> inspecting: explaining layout, styling and console errors, and proposing CSS, element and form changes
> that run only after the user approves them.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings, pairing token and CSS patches locally, and per-tab conversation/undo state. |
| `scripting` | Inserts and removes the CSS changes the user approved (`insertCSS` / `removeCSS`), including saved per-site patches. |
| `webNavigation` | Detects when a page the user saved a patch for starts loading, to reapply that patch. |
| Host permission `<all_urls>` | The tool works on whatever page the user is inspecting in DevTools, so it must be able to read that page (on request), capture its console errors, take screenshots, and apply approved CSS on any site. |
| Content scripts on `<all_urls>` | `console-capture.js` records console errors on the page so the AI can explain them; `patch-toggles.js` shows on/off buttons for patches the user saved with a toggle. Neither sends data anywhere. |
| Remote code | **No.** All code is in the package. The AI's suggestions are data; optional user-approved scripts run via DevTools' `inspectedWindow.eval`, never fetched from a server. |

**Data usage disclosures** (check these in the form):
- Website content: **yes**, only on pages the user inspects, sent to the user's local server and their chosen AI provider.
- Web history, personally identifiable info, authentication info, financial/health data, personal communications,
  location, user activity: **no** (not collected; sensitive headers are removed before anything is sent).
- Certify: not sold to third parties; not used for unrelated purposes; not used for creditworthiness/lending.

**Privacy policy URL:** publish `store/PRIVACY.md` (for example as a GitHub Pages page or the file's GitHub URL)
and paste the link.

## Before each release

1. Bump `version` in `extension/manifest.json` (the store rejects re-uploads of the same version).
2. `npm test`, then `npm run package`.
3. If stored data changed shape: add a migration (server: `server/src/storage/data-version.js`,
   extension: `STORAGE_MIGRATIONS` in `background/service-worker.js`).
4. Upload `dist/integratedai-<version>.zip` in the Developer Dashboard.
