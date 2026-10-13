import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const URL_ = process.env.AXURE_URL || 'https://axure.example.com/ProjectB';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
const page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);

// locate the content frame
let content = null;
for (const f of page.frames()) {
  const n = await f.evaluate(() => document.querySelectorAll('#base [id^="u"]').length).catch(() => 0);
  console.log('frame', f.name() || '(main)', 'widgets=', n);
  if (n > 0) content = f;
}
console.log('content frame:', content && (content.name() || '(main)'));
console.log('typeof frame.screenshot =', typeof content.screenshot);
console.log('typeof frame.page =', typeof content.page);
console.log('typeof page.screenshot =', typeof page.screenshot);
try {
  const buf = await content.screenshot({ type: 'png' });
  console.log('frame.screenshot OK bytes=', buf.length);
} catch (e) { console.log('frame.screenshot ERR', String(e).slice(0, 200)); }

// run the extraction source standalone with a stack trace
const src = readFileSync('../../src/axure-page.ts', 'utf8');
const start = src.indexOf('const EXTRACT_SOURCE = String.raw`');
const end = src.indexOf('`;', start);
const body = src.slice(src.indexOf('`', start) + 1, end);
console.log('extracted source length', body.length);
const result = await content.evaluate((code) => {
  try {
    const factory = new Function(`${code}; return axureExtractOutline;`)();
    const out = factory({ includeNotes: true });
    return { ok: true, widgets: out.totalWidgets, top: out.nodes.length };
  } catch (e) {
    return { ok: false, error: String(e), stack: (e && e.stack || '').split('\n').slice(0, 6).join(' | ') };
  }
}, body);
console.log('extract result', JSON.stringify(result, null, 1));
await browser.close();


