// @ts-check
/**
 * Searching the user's imported past chats (chatgpt-export.js): words in the title and text, best matches first,
 * with excerpts around the matches. Plain word matching on this computer: no index, no AI, nothing sent anywhere.
 */

/** Words that say nothing about what to find. */
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'about', 'is', 'are', 'was', 'were', 'i', 'my', 'me', 'we', 'you',
  'it', 'that', 'this', 'what', 'did', 'do', 'how', 'when', 've', 'bir', 've', 'ile', 'için', 'bu', 'ne', 'mi']);

/** @param {string} text */
const fold = (text) => text.normalize('NFKC').toLowerCase();

/**
 * The words of a query that are worth looking for.
 * @param {string} query
 * @returns {string[]}
 */
export function queryWords(query) {
  const words = [...new Set(fold(query).match(/[\p{L}\p{N}]+/gu) ?? [])];
  const useful = words.filter((w) => w.length > 1 && !STOP.has(w));
  return (useful.length ? useful : words).slice(0, 12);
}

/**
 * How well a chat fits the query (0 = not at all): words found in the title count most, the whole phrase more
 * still; at least half of the words have to be there.
 * @param {{ title: string, text: string }} doc
 * @param {string[]} words  from queryWords
 * @param {string} phrase   the whole query, folded
 */
export function scoreChat(doc, words, phrase) {
  if (!words.length) return 0;
  const title = fold(doc.title);
  const text = fold(doc.text);
  let found = 0;
  let score = 0;
  for (const word of words) {
    const inTitle = title.includes(word);
    let count = 0;
    for (let at = text.indexOf(word); at >= 0 && count < 5; at = text.indexOf(word, at + word.length)) count++;
    if (inTitle || count) found++;
    score += (inTitle ? 5 : 0) + count;
  }
  if (found < Math.ceil(words.length / 2)) return 0;
  if (words.length > 1 && phrase.length > 3 && (text.includes(phrase) || title.includes(phrase))) score += 10;
  return score + (found === words.length ? 5 : 0);
}

/**
 * Pieces of the chat around what was found (up to `max`, each about 400 characters).
 * @param {string} text
 * @param {string[]} words
 * @param {string} phrase
 * @param {number} [max]
 */
export function excerpts(text, words, phrase, max = 3) {
  const folded = fold(text);
  // (Folding rarely changes a text's length; when it does, positions are only roughly right, which is fine here.)
  /** @type {number[]} */
  const hits = [];
  const phraseAt = words.length > 1 && phrase.length > 3 ? folded.indexOf(phrase) : -1;
  if (phraseAt >= 0) hits.push(phraseAt);
  for (const word of words) {
    const at = folded.indexOf(word);
    if (at >= 0) hits.push(at);
  }
  hits.sort((a, b) => a - b);
  /** @type {[number, number][]} */
  const windows = [];
  for (const at of hits) {
    const start = Math.max(0, at - 160);
    const end = Math.min(text.length, at + 240);
    const last = windows.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else if (windows.length < max) windows.push([start, end]);
  }
  return windows.map(([start, end]) => `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`);
}

/**
 * Keeps the best `limit` matches while chats go by (the store hands them over one at a time).
 * @param {string} query
 * @param {number} [limit]
 */
export function chatSearcher(query, limit = 5) {
  const words = queryWords(query);
  const phrase = fold(query).replace(/\s+/g, ' ').trim();
  /** @type {{ score: number, doc: import('./chatgpt-export.js').ChatDoc }[]} */
  let best = [];
  let total = 0;
  return {
    /** @param {import('./chatgpt-export.js').ChatDoc} doc */
    add(doc) {
      const score = scoreChat(doc, words, phrase);
      if (!score) return;
      total++;
      best.push({ score, doc });
      // Better matches first; among equals, the newer chat.
      best.sort((a, b) => b.score - a.score || b.doc.time - a.doc.time);
      if (best.length > limit) best = best.slice(0, limit);
    },
    results() {
      return {
        total,
        matches: best.map(({ doc }) => ({
          id: doc.id,
          title: doc.title,
          date: doc.time ? new Date(doc.time).toISOString().slice(0, 10) : '',
          excerpts: excerpts(doc.text, words, phrase),
        })),
      };
    },
  };
}
