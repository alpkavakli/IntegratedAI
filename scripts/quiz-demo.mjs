// @ts-check
/**
 * A practice quiz shaped like NetAcad's, for trying the agent on frames by hand:
 *
 *   npm run quiz-demo        then open http://127.0.0.1:8790/
 *
 * The course page (127.0.0.1) holds a player frame (same site), which holds the quiz frame from another
 * address (localhost, reached through a redirect, so its address isn't its src). Three dropdown questions,
 * a Next button, and a score at the end. Ctrl+C stops it. Nothing here is sent anywhere.
 */

import http from 'node:http';

const PORT = 8790;
const QUESTIONS = [
  ['An individual user profile on a social network site is an example of an', ['online', 'offline'], 'identity.', 'online'],
  ['A strong password should be at least', ['4', '8', '12'], 'characters long, and longer is better.', '12'],
  ['Data that is in use, in transit or at', ['rest', 'risk', 'random'], 'needs to be protected.', 'rest'],
];

const page = (/** @type {string} */ title, /** @type {string} */ body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;color:#202124}select,button{font:inherit;padding:6px 10px}</style></head><body>${body}</body></html>`;

const course = page('Course: Introduction to Cybersecurity', `
<header style="padding:12px 20px;border-bottom:1px solid #dadce0;display:flex;gap:16px;align-items:center">
  <strong>Practice Academy</strong><span>Introduction to Cybersecurity</span><span style="margin-left:auto">Signed in as Test Student</span>
</header>
<div style="display:flex">
  <nav style="width:220px;padding:16px;border-right:1px solid #dadce0;min-height:80vh">
    <p><b>Course outline</b></p><p>1.1 The World of Cybersecurity</p><p>1.2 Organizational Data</p><p><b>1.6 Quiz (practice)</b></p>
  </nav>
  <main style="flex:1;padding:16px">
    <iframe src="/player" title="Course player" style="width:720px;height:520px;border:1px solid #dadce0"></iframe>
  </main>
</div>`);

const player = page('Player', `
<div style="padding:8px 12px;background:#f1f3f4;border-bottom:1px solid #dadce0">1.6. Quiz &nbsp;·&nbsp; Module 1</div>
<iframe src="http://localhost:${PORT}/launch?course=i2cs" title="Quiz" style="width:100%;height:470px;border:0"></iframe>`);

const quiz = page('Quiz', `
<div id="quiz" style="padding:24px"></div>
<script>
  const QUESTIONS = ${JSON.stringify(QUESTIONS)};
  let at = 0;
  const answers = [];
  const show = () => {
    const box = document.getElementById('quiz');
    if (at >= QUESTIONS.length) {
      const right = answers.filter((a, i) => a === QUESTIONS[i][3]).length;
      box.innerHTML = '<h1>Quiz complete</h1><p id="score">Score: ' + right + ' of ' + QUESTIONS.length + '</p>';
      return;
    }
    const [before, options, after] = QUESTIONS[at];
    box.innerHTML = '<p style="color:#5f6368">Q' + (at + 1) + ' of ' + QUESTIONS.length + '</p><h1>Question ' + (at + 1) + '</h1>'
      + '<p>' + before + ' <select id="answer" aria-label="Answer"><option value="">Please select an option</option>'
      + options.map((o) => '<option>' + o + '</option>').join('') + '</select> ' + after + '</p>'
      + '<button id="next" disabled>Next</button>';
    const select = document.getElementById('answer');
    const next = document.getElementById('next');
    select.addEventListener('change', () => { next.disabled = !select.value; });
    next.addEventListener('click', () => { answers[at] = select.value; at++; show(); });
  };
  show();
</script>`);

http.createServer((req, res) => {
  const html = (/** @type {string} */ body) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  const host = req.headers.host ?? '';
  if (req.url?.startsWith('/launch')) return res.writeHead(302, { location: '/quiz.html?attempt=1' }).end();
  if (req.url?.startsWith('/quiz.html') && host.startsWith('localhost')) return html(quiz);
  if (req.url === '/player') return html(player);
  if (req.url === '/') return html(course);
  res.writeHead(404).end();
}).listen(PORT, '0.0.0.0', () => console.log(`Practice quiz: http://127.0.0.1:${PORT}/   (Ctrl+C stops it)`));
