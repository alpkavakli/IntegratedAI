// @ts-check
/**
 * Minimal Markdown → DOM renderer for model replies.
 *
 * SECURITY: model output is untrusted. This builds DOM nodes with textContent
 * only; it never uses innerHTML, so HTML in a reply is shown as text, not run.
 *
 * Supported: paragraphs, # headings, - / 1. lists, ``` fenced code ```,
 * `inline code`, **bold**, *italic* / _italic_. Links are shown as plain text.
 */

/**
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  /** @type {HTMLElement | null} */
  let list = null;
  /** @type {string[]} */
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInline(p, paragraph.join(' '));
    frag.append(p);
    paragraph = [];
  };
  const closeList = () => { list = null; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      flushParagraph(); closeList();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      const pre = document.createElement('pre');
      const el = document.createElement('code');
      if (fence[1]) el.dataset.lang = fence[1];
      el.textContent = code.join('\n');
      pre.append(el);
      frag.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      flushParagraph(); closeList();
      const h = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      appendInline(h, heading[2]);
      frag.append(h);
      continue;
    }

    const item = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
    if (item) {
      flushParagraph();
      const ordered = /\d/.test(item[1]);
      if (!list || (list.tagName === 'OL') !== ordered) {
        list = document.createElement(ordered ? 'ol' : 'ul');
        frag.append(list);
      }
      const li = document.createElement('li');
      appendInline(li, item[2]);
      list.append(li);
      continue;
    }

    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    closeList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  return frag;
}

/**
 * Inline formatting: `code`, **bold**, *italic*.
 * @param {HTMLElement} parent
 * @param {string} text
 */
function appendInline(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(text.slice(last, match.index));
    const token = match[0];
    /** @type {HTMLElement} */
    let el;
    if (token.startsWith('`')) { el = document.createElement('code'); el.textContent = token.slice(1, -1); }
    else if (token.startsWith('**')) { el = document.createElement('strong'); el.textContent = token.slice(2, -2); }
    else { el = document.createElement('em'); el.textContent = token.slice(1, -1); }
    parent.append(el);
    last = /** @type {number} */ (match.index) + token.length;
  }
  parent.append(text.slice(last));
}
