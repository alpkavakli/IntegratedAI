# Chrome Web Store submission kit

Everything the Developer Dashboard asks for, ready to paste. Build the upload with `npm run package`
(writes `dist/integratedai-<version>.zip` after checking the manifest against store rules).

## Store listing

**Name:** Browser IntegratedAI DevTools

**Summary (from the manifest, ≤ 132 chars):**
AI panel in Chrome DevTools: explains layout and console errors, previews CSS fixes, fills forms, saves per-site patches.

**Category:** Developer Tools

**Languages:** English (default) and Turkish. The name and summary come from `extension/_locales/<lang>/messages.json`;
the dashboard takes a description per language (Store listing → language menu), below.

**Description:**

> An AI assistant inside Chrome DevTools. Select an element in the Elements panel, switch to the **AI** tab and
> ask: "why is this overflowing?", "make this look better", "add a dark-mode toggle to the nav bar".
>
> Your data stays yours: the developer receives nothing. Page content goes only to the AI provider you choose (or
> to Ollama on your own computer), only when you ask, and conversations stay in your browser.
>
> No DevTools needed for quick questions: click the toolbar button for the **AI card on the page**. Ask about the
> page, have it read or explain things, and preview CSS fixes. Drag it anywhere, or against the side as a panel.
>
> HOW IT WORKS
> 1. Install it: the setup page opens. Choose your AI: paste an API key, or use free local models with Ollama.
> 2. On any page, click the IntegratedAI icon in the toolbar (or press Alt+Shift+A): a small card opens.
> 3. Ask about the page, or click Pick element and ask about one part of it.
> 4. Each change it proposes is a card: Preview it, then Apply, or Undo later.
> 5. Keep CSS fixes as site patches. For everything else, press F12 and open the AI tab.
>
> - **Understands the page you're inspecting:** the selected element, its styles, matching CSS rules, console
>   errors, network requests and screenshots.
> - **Proposes, you approve:** every change is a card you preview, apply or undo. Nothing runs on its own.
> - **CSS fixes and themes**, saved as per-site patches with optional on/off buttons on the page.
> - **Does things for you:** fills in forms, chooses options and clicks through flows with real browser events.
> - **Agent modes:** let it work through a task on the page by itself, step by step while you watch. It asks before
>   each step, or only before risky ones (submitting, sending, paying, deleting); you choose.
> - **Translates the page** into your language, and puts the original text back with one click.
> - **Remembers each site:** key selectors and your preferences, so the next conversation starts informed.
> - **Explains console errors** and jumps to the source.
> - **Your key, your choice:** paste an API key for Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, DeepSeek,
>   Qwen, Kimi, GLM or MiniMax and go, use free local models with Ollama, or connect any OpenAI-compatible service.
>   It talks straight to that provider; conversations and site memory stay in your browser. No account with us,
>   no tracking.
> - **Separate memories:** keep a conversation's notes private to it, or share them across the site.
>
> Developers can instead run the free local agent server to use a Claude subscription through Claude Code
> and move CSS into their own project ("Apply to source"): https://github.com/alpkavakli/IntegratedAI

**Description in Turkish (Türkçe):**

> Chrome DevTools içinde bir yapay zekâ asistanı. Elements panelinde bir öğe seç, **AI** sekmesine geç ve sor:
> "bu neden taşıyor?", "bunu daha güzel göster", "gezinme çubuğuna koyu mod düğmesi ekle".
>
> Hızlı sorular için DevTools gerekmez: araç çubuğundaki düğmeye tıkla, **sayfadaki yapay zekâ kartı** açılsın.
> Sayfa hakkında sor, bir şeyleri okut ya da açıklat, CSS düzeltmelerini önizle. Kartı istediğin yere sürükle
> ya da panel olarak kenara yasla.
>
> - **İncelediğin sayfayı anlar:** seçili öğe, stilleri, eşleşen CSS kuralları, konsol hataları, ağ istekleri
>   ve ekran görüntüleri.
> - **O önerir, sen onaylarsın:** her değişiklik önizleyip uygulayabileceğin ya da geri alabileceğin bir karttır.
>   Hiçbir şey kendiliğinden çalışmaz.
> - **CSS düzeltmeleri ve temalar**, sayfada isteğe bağlı aç/kapa düğmeleriyle site yamaları olarak kaydedilir.
> - **Senin yerine yapar:** gerçek tarayıcı olaylarıyla form doldurur, seçenek seçer ve adımları tıklayarak ilerler.
> - **Ajan modları:** bir işi sayfada kendi başına, sen izlerken adım adım yapsın. Her adımdan önce ya da yalnızca
>   riskli adımlardan (gönderme, yollama, ödeme, silme) önce sorar; sen seçersin.
> - **Sayfayı çevirir:** sayfanın metnini istediğin dile çevirir; Geri al ile eski hâline döner.
> - **Her siteyi hatırlar:** önemli seçicileri ve tercihlerini, böylece bir sonraki sohbet bilgili başlar.
> - **Konsol hatalarını açıklar** ve kaynağa atlar.
> - **Senin anahtarın, senin seçimin:** Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, DeepSeek, Qwen, Kimi,
>   GLM veya MiniMax için bir API anahtarı yapıştır ve başla, Ollama ile ücretsiz yerel modeller kullan ya da
>   OpenAI uyumlu herhangi bir hizmeti bağla. Doğrudan o sağlayıcıyla konuşur; sohbetler ve site hafızası
>   tarayıcında kalır. Bizde hesap yok, izleme yok.
> - **Ayrı hafızalar:** bir sohbetin notlarını ona özel tut ya da site genelinde paylaş.
>
> Geliştiriciler bunun yerine ücretsiz yerel ajan sunucusunu çalıştırıp Claude aboneliğini Claude Code üzerinden
> kullanabilir ve CSS'i kendi projelerine taşıyabilir ("Kaynağa uygula"): https://github.com/alpkavakli/IntegratedAI

The interface follows Chrome's language: Turkish when Chrome is in Turkish, English otherwise. To check it, start
Chrome with `--lang=tr` (and a separate profile).

**Screenshots (1280×800), ready in `store/screenshots/`**, upload in this order:
1. `01-card.png`: the card on the page (toolbar button): the picked badge, the cause, and a previewed CSS fix
2. `02-theme-toggle.png`: in DevTools: a dark reading theme with an on/off button in the site's nav bar
3. `03-forms.png`: Auto mode: it filled in a sign-up form by itself and asks before submitting (the button is outlined on the page)
4. `04-tasks.png`: those steps saved as a task in the Tasks tab, to run again without the AI
5. `05-options.png`: the setup page: choosing an AI, and how to start using it

They come from real use of the extension on original demo pages (`store/demo-pages/`). Regenerate after UI
changes with `node scripts/store-screenshots.mjs` (needs Chrome and a logged-in Claude Code; makes a few real
AI calls), or a single one with e.g. `node scripts/store-screenshots.mjs 03-forms`.

**Store icon (128×128):** `extension/icons/icon128.png`: 96×96 artwork with 16 px transparent padding and a faint
light glow so the dark icon shows on dark backgrounds (Chrome's icon guidance). The 16/32/48 px toolbar icons fill
their square.

**Small promo tile (440×280, required):** `store/screenshots/promo-tile-440x280.png`.
**Marquee (1400×560, optional, needed to be featured):** `store/screenshots/marquee-1400x560.png`.
Both follow the store's promo guidance: saturated blue, the icon large, only the name as text, readable at half size.
Sources: `store/promo-tile.html` and `store/marquee.html`; render with headless Chrome, e.g.
`chrome --headless=new --hide-scrollbars --window-size=440,280 --screenshot=<png> store/promo-tile.html`.

**Additional fields:** Homepage URL `https://alpkavakli.github.io/IntegratedAI/`,
support URL `https://github.com/alpkavakli/IntegratedAI/issues`.

## Privacy practices tab

**Single purpose:**
> An AI assistant for the web page the user is looking at, in Chrome DevTools or as a card on the page opened from the
> toolbar button, that helps the user understand and change that page: explaining layout, styling and console errors, reading or translating its text, proposing CSS, element and form changes, and,
> only when the user turns on an agent mode for a conversation, operating that page for them (clicking, typing,
> opening pages) with the confirmations the user chose.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings, API keys or pairing token, and CSS patches locally, and per-tab conversation/undo state. In direct mode also the site memory notes (conversations are kept in the extension's IndexedDB). |
| `scripting` | Inserts and removes the CSS changes the user approved (`insertCSS` / `removeCSS`), including saved per-site patches. Shows the AI card on the page when the user clicks the toolbar button (`executeScript` with the packaged `content/card-host.js`), and, while the card is open, runs the extension's own packaged page functions in that tab to read the page or apply an approved change. No code from outside the package is run this way. |
| `webNavigation` | Detects when a page the user saved a patch for starts loading, to reapply that patch (also in the page's frames, found with `getAllFrames`), and puts the AI card back on the next page of a tab where the user left it open. |
| Host permission `<all_urls>` | The tool works on whatever page the user is inspecting in DevTools, so it must be able to read that page (on request), capture its console errors, take screenshots, and apply approved CSS on any site. |
| Optional permission `nativeMessaging` | Asked for only when a user of the optional local agent server clicks the panel's Server button: it lets the extension ask a helper program the user installed themselves (`npm run services:install`) to start or stop that server. It sends only "status", "start" or "stop". Most users (API key or Ollama) never see this request. |
| Toolbar button (`action`), `web_accessible_resources` | The toolbar button opens the AI card on the current page. The card is the extension's own panel page shown in a frame on the page; the two page-helper files are loaded into the extension's isolated world to read the page for it. Nothing is loaded from outside the package. |
| Content scripts on `<all_urls>` | `console-capture.js` records console errors on the page so the AI can explain them; `patch-toggles.js` shows on/off buttons for patches the user saved with a toggle. Neither sends data anywhere. |
| Remote code | See "Remote code" below: answer **Yes** and paste the justification. |

**Data usage disclosures** (check these in the form):
- Website content: **yes**, only on pages the user inspects, sent to the AI provider the user chose (Anthropic,
  OpenAI, Google, OpenRouter, DeepSeek, Alibaba Cloud, Moonshot AI, Z.ai or MiniMax) with the user's own key
  (direct mode), to Ollama on the user's own computer, or to
  the user's local server.
- Authentication info: the user's own API keys are stored locally and each is sent only to its own provider
  to authenticate their requests (declare it if the form asks; never sent to the developer).
- Personal communications: **yes**. When the user asks the AI to read or work on a page that shows messages or
  email (e.g. a web chat), the text it reads from that page goes to the AI provider the user chose, like any other
  website content. Only on request, only from the inspected tab, never to the developer.
- User activity: **yes**. Its examples include "network monitoring": the AI can read the page's network log
  (request method, URL, status, timing; no bodies, cookies or auth headers) when the Network chip is on or it asks.
  Sent only to the AI provider the user chose.
- Web history, personally identifiable info, financial/health data, location: **no** (not collected;
  cookies, authorization headers and token-like URL parameters are removed before anything is sent, and password
  field values are never read).
- Certify: not sold to third parties; not used for unrelated purposes; not used for creditworthiness/lending.

## Remote code

The extension's own code is all in the package. One optional feature runs code that is not: **"Let it suggest
JavaScript"** (Options → Advanced settings, **off by default**). When it is on, the AI can propose a script; the user
sees the full code in a card, must tick "I reviewed this code" and click Run. Answering "No" would be inaccurate, so
answer **Yes** with this justification:

> The extension never loads or runs remote code in its own pages, service worker or content scripts. One optional,
> off-by-default feature lets the user run a JavaScript snippet suggested by the AI model they configured, in the web
> page they are inspecting, the same way they could paste it into the DevTools console. The code is shown to the user
> in full and runs only after they tick "I reviewed this code" and click Run, each time. It is executed with
> `chrome.devtools.inspectedWindow.eval()` in the inspected page's own JavaScript context, which has no access to
> extension APIs, storage or permissions; the extension does not eval anything in its own contexts. The policy exempts
> "code run in contexts that are isolated from extension APIs".

If the review still rejects it, the fallback is a store build without `execute_js` (the owner prefers keeping it).

## Test instructions (the dashboard's "Test instructions" field)

> No account is needed. 1) After installing, the setup page opens (later: right-click the toolbar icon → Options).
> Choose Ollama (free, runs locally) or paste an API key for one of the listed providers, and click Check. 2) On any
> page, click the toolbar icon: a card opens on the page. Ask "summarize this page", or pick an element and ask "why is
> this cut off?". 3) In DevTools (F12), open the AI tab: select an element in the Elements panel and ask about it.
> Changes appear as cards and only run when you click Apply. Agent modes (menu under the message box) let it click and
> type on the page, asking first as configured. The JavaScript feature is off by default: Options → Advanced settings →
> "Let it suggest JavaScript".

**Privacy policy URL:** https://alpkavakli.github.io/IntegratedAI/privacy.html
(GitHub Pages from `/docs` on `main`; rebuild with `npm run site` after changing `store/PRIVACY.md`, then push.)

## Before each release

1. Bump `version` in `extension/manifest.json` (the store rejects re-uploads of the same version).
2. `npm test`, then `npm run package`.
3. If stored data changed shape: add a migration (server: `server/src/storage/data-version.js`,
   extension: `STORAGE_MIGRATIONS` in `background/service-worker.js`).
4. Upload `dist/integratedai-<version>.zip` in the Developer Dashboard.
