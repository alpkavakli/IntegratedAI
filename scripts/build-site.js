// @ts-check
/**
 * Build the public website (privacy policy + a small landing page) into docs/ (GitHub Pages can serve that folder):
 *
 *   npm run site
 *
 * The privacy policy is generated from store/PRIVACY.md, so there is one source
 * of truth. docs/ is plain HTML/CSS: host it with GitHub Pages (or anywhere
 * static) and use https://<host>/privacy.html as the Web Store privacy URL.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(`${root}/extension/manifest.json`, 'utf8'));
const markdown = readFileSync(`${root}/store/PRIVACY.md`, 'utf8');
// The manifest's name and summary may be "__MSG_key__" (translated): take the English text then.
const messages = JSON.parse(readFileSync(`${root}/extension/_locales/${manifest.default_locale ?? 'en'}/messages.json`, 'utf8'));
const text = (/** @type {string} */ value) => value.replace(/^__MSG_(\w+)__$/, (_, key) => messages[key]?.message ?? value);
const name = text(manifest.name);

mkdirSync(`${root}/docs`, { recursive: true });
writeFileSync(`${root}/docs/privacy.html`, page(`Privacy policy · ${name}`, markdownToHtml(markdown)));
writeFileSync(`${root}/docs/index.html`, page(name, `
<h1>${escapeHtml(name)}</h1>
<p class="lead">${escapeHtml(text(manifest.description))}</p>
<ul>
  <li>On any page, click the toolbar icon: a card opens on the page. Ask about the page, have it summarize or translate it, or pick an element and ask why it looks wrong.</li>
  <li>In DevTools, select an element in the Elements panel, open the <strong>AI</strong> tab, and ask: "why is this overflowing?", "make this look better", "add a dark-mode toggle to the nav bar".</li>
  <li>Every change is a card you preview and approve. Nothing runs on its own.</li>
  <li>Use your own API key (Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, Qwen, Kimi, GLM, MiniMax or any OpenAI-compatible service), free local models with Ollama, or the local agent server with your Claude subscription.</li>
  <li>English and Turkish interface. Free and open source (GNU AGPL).</li>
</ul>
<p><a href="privacy.html">Privacy policy</a> · <a href="https://github.com/alpkavakli/IntegratedAI">Source code and guide</a> · <a href="https://github.com/alpkavakli/IntegratedAI/issues">Report a problem</a> · <a href="mailto:alpkavakli@gmail.com?subject=IntegratedAI">alpkavakli@gmail.com</a></p>
`));
writeFileSync(`${root}/docs/.nojekyll`, ''); // serve files as-is on GitHub Pages
console.log('Built docs/index.html and docs/privacy.html');

/**
 * @param {string} title
 * @param {string} body
 */
function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg: #ffffff; --fg: #202124; --muted: #5f6368; --accent: #1a73e8; --border: #dadce0; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1f1f1f; --fg: #e8eaed; --muted: #9aa0a6; --accent: #8ab4f8; --border: #3c4043; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 1.8rem; line-height: 1.25; margin: 0 0 8px; }
  h2 { font-size: 1.2rem; margin: 2rem 0 0.5rem; padding-top: 1rem; border-top: 1px solid var(--border); }
  a { color: var(--accent); }
  code { font: 0.9em ui-monospace, Menlo, Consolas, monospace; }
  em { color: var(--muted); }
  .lead { font-size: 1.15rem; color: var(--muted); }
  li { margin: 4px 0; }
</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
}

/**
 * Just enough Markdown for the policy: headings, paragraphs, (nested) lists,
 * ordered lists, **bold**, _italic_, `code` and [links](url).
 * @param {string} md
 */
function markdownToHtml(md) {
  const out = [];
  /** @type {string[]} */
  const stack = []; // open list tags, by indentation level
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeLists = (depth = 0) => { while (stack.length > depth) out.push(`</${stack.pop()}>`); };

  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^(#{1,3})\s+(.*)/);
    const item = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
    if (heading) {
      flush(); closeLists();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (item) {
      flush();
      // Nesting by indentation: none = top level, up to 4 spaces = second level, more = third.
      const indent = item[1].length;
      const depth = indent === 0 ? 1 : indent <= 4 ? 2 : 3;
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
      closeLists(depth);
      if (stack.length < depth) { out.push(`<${tag}>`); stack.push(tag); }
      out.push(`<li>${inline(item[3])}</li>`);
    } else if (!line.trim()) {
      flush();
      if (stack.length) closeLists();
    } else if (stack.length && /^\s{2,}/.test(line)) {
      // continuation of the previous list item
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
    } else {
      closeLists();
      paragraph.push(line.trim());
    }
  }
  flush(); closeLists();
  return out.join('\n');
}

/** @param {string} text */
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,:;]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,:;]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/** @param {string} text */
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
