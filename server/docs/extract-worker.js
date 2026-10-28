// Runs in a worker thread: reads a PDF page by page and reports each page's text and
// title-block sheet number, so large drawing sets never freeze the app.
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const SHEET_RE = /^(?:[A-Z]{1,3}[-.]?\d{1,3}(?:\.\d{1,3})?[A-Z]?)$/;
const TITLE_HINT = /\b(PLAN|ELEVATION|SECTION|DETAIL|SCHEDULE|NOTES|FOUNDATION|FRAMING|ROOF|FLOOR|SITE|REFLECTED|CEILING|WALL|STAIR|ENLARGED|PLUMBING|ELECTRICAL|MECHANICAL|COVER|LEGEND)/;

function detectSheet(items, view) {
  const [, , w, h] = view;
  let sheet = null;
  let title = null;
  for (const it of items) {
    const str = (it.str || '').trim();
    if (!str) continue;
    const size = Math.hypot(it.transform[0], it.transform[1]);
    const x = it.transform[4];
    const y = it.transform[5];
    const corner = x > w * 0.6 && y < h * 0.35; // title blocks sit bottom-right
    if (SHEET_RE.test(str) && /\d/.test(str)) {
      const score = size * (corner ? 3 : 1);
      if (!sheet || score > sheet.score) sheet = { value: str, score };
    } else if (corner && TITLE_HINT.test(str.toUpperCase()) && str.length >= 6 && str.length < 60) {
      if (!title || size > title.size) title = { value: str, size };
    }
  }
  return { sheet: sheet?.value || null, title: title?.value || null };
}

const task = getDocument({ data: new Uint8Array(fs.readFileSync(workerData.file)), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
const pdf = await task.promise;
parentPort.postMessage({ type: 'start', pages: pdf.numPages });
for (let n = 1; n <= pdf.numPages; n++) {
  const page = await pdf.getPage(n);
  const tc = await page.getTextContent();
  const text = tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim();
  parentPort.postMessage({ type: 'page', page: n, text: text.slice(0, 60000), ...detectSheet(tc.items, page.view) });
  page.cleanup();
}
await task.destroy();
parentPort.postMessage({ type: 'done' });
