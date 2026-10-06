# IntegratedAI DevTools: Privacy Policy

_Last updated: 2026-10-06_

IntegratedAI DevTools ("the extension") adds an AI panel to Chrome DevTools. This policy explains what data
the extension handles and where it goes. In short: **the developer does not collect, receive or sell any of
your data.** Depending on the connection you choose in Options, the extension talks either directly to the
AI provider you choose (Anthropic, OpenAI, Google Gemini or OpenRouter) with your own API key, or to Ollama
running on your own computer ("direct mode"), or to an agent server that runs on your own computer, which talks to the AI provider you choose.

## What the extension reads

Only when you use the AI panel, and only from the tab you are inspecting:

- **Page content you choose to share.** For example, the element selected in the Elements panel (its HTML
  excerpt, CSS selector and computed styles), page URL and title, and more details the AI asks for while
  answering (matching CSS rules, element lists, an outline of what's on screen, the text of the page or of part
  of it including the values in its form fields, page resources), also from frames embedded in the page.
  Password fields are never read out: the AI only learns whether one is filled in.
  Whatever the page shows can be part of this: if you ask the AI to read or work on a page with messages, email
  or personal details, that text is sent to the AI provider you chose, as part of answering you.
- **Console messages and errors** captured on the page (when you enable the Console chip, ask about errors,
  or the AI inspects the console).
- **Network request summaries** from DevTools (method, URL, status, size, timing), when you enable the
  Network chip or the AI inspects the network. Cookies, authorization headers, API keys and token-like URL
  parameters are removed before anything is sent. Response bodies are never sent.
- **Screenshots** of an element or of the visible page, when the AI needs to see how something looks.

## Where it goes

- **Direct mode:** straight from the extension to the provider you picked, authenticated with your own API
  key, under that provider's terms:
  - Anthropic, `api.anthropic.com` ([privacy policy](https://www.anthropic.com/legal/privacy))
  - OpenAI, `api.openai.com` ([privacy policy](https://openai.com/policies/privacy-policy/))
  - Google Gemini, `generativelanguage.googleapis.com` ([privacy policy](https://policies.google.com/privacy))
  - OpenRouter, `openrouter.ai`, which forwards to the model you choose ([privacy policy](https://openrouter.ai/privacy))
  - Ollama, which runs models on your own computer (by default `localhost:11434`, or the address you enter
    in Options). No key is used and nothing leaves your computer, unless you enter the address of another machine.
- **Local server mode:**
   1. **To the agent server on your computer** (`127.0.0.1`), which you install and start yourself. The
      connection is local and requires a pairing token. Websites cannot connect to it.
   2. **From there, to the AI provider you selected**, using your own account:
      - *Claude Code CLI*: Anthropic, under your Claude account ([Anthropic privacy policy](https://www.anthropic.com/legal/privacy)).
      - *Anthropic API*: Anthropic, under your API key.
      - Other providers, if you add them, under their own terms.
- **Web search**, in both modes (optional, on by default, can be turned off in Options): the AI may search
  the web or fetch pages through the provider's web tools to look up documentation.

Nothing is sent to the developer of this extension or to any other third party.

## What is stored, and where

All storage is local to your computer:

- **In Chrome** (extension storage): your settings, your API keys (direct mode), the pairing token
  (local server mode), saved CSS patches and saved tasks (the page steps you chose to save, including what was
  typed, but never what was typed into a password field). In direct mode also your conversations (IndexedDB) and site
  memory, including private per-conversation memory. Removed when you uninstall the extension, or via
  *Options → Your data → Delete extension data*. Each API key is only ever sent to its own provider.
  *Options → Your data → Export* saves this data (without API keys or the pairing token) to a file on your
  computer, only when you click it.
- **Local server mode, on your computer, in the agent server's folder** (`~/.integratedai`): conversations, site memory notes
  and page types, logs of failed calls, and automatic backups made before data-format updates. You can
  view, back up or delete this folder at any time; individual memory notes can be edited or deleted in the
  panel's Memory tab.

## What the extension does on pages

- When you click its toolbar button, shows the AI card on that page (and on the tab's next pages until you close
  it). The card reads and sends the same page data as the DevTools panel (above), only when you use it.

- Captures console messages on pages you visit (kept in the page's memory only, never sent anywhere
  unless you use the AI panel on that tab).
- Applies CSS patches you saved, and shows on/off buttons for patches you created with a toggle.
- Makes changes on a page (CSS, element edits, clicks/typing, scripts) **only after you approve them**, unless you
  choose an agent mode for a conversation:
  - *Ask each step*: the AI clicks, types and opens pages in that tab, asking you before each step.
  - *Auto*: it does so without asking, except before risky steps (submitting forms, sending, paying, deleting,
    password fields, going to another site).
  - *Full auto*: it does so without asking. You switch this on per conversation, after a warning.

  Style changes, element edits and scripts still wait for your approval in every mode. Agent modes don't change
  what data is read or where it goes (above); a "working… Stop" badge on the page lets you stop the AI at any time.
- Runs a saved task's steps when you click **Run** in the Tasks tab, without the AI and without sending anything
  anywhere. It asks you before risky steps, as in Auto mode, and the same Stop badge stops it.

## Children

The extension is not directed at children under 13.

## Changes

Changes to this policy are published at the same address and in the extension's repository.

## Contact

Alp Kavaklı: alpkavakli@gmail.com · https://github.com/alpkavakli/IntegratedAI
