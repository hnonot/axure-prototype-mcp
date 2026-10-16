import { chromium } from 'playwright';
import { DEFAULT_PAGE } from './_env.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.env.OUT || './recon-out';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

console.log('--- goto ---');
const resp = await page.goto(DEFAULT_PAGE, { waitUntil: 'load', timeout: 60000 });
console.log('status', resp && resp.status(), 'url', page.url());
await page.waitForTimeout(4000);

console.log('--- title ---', await page.title());

// Structure survey
const survey = await page.evaluate(() => {
  const out = {};
  out.frames = Array.from(document.querySelectorAll('iframe,frame')).map((f) => ({
    tag: f.tagName, id: f.id, name: f.name, src: f.getAttribute('src'),
  }));
  out.totalElements = document.querySelectorAll('*').length;
  const ids = {};
  document.querySelectorAll('[id]').forEach((el) => {
    const key = el.id.replace(/[0-9]+/g, '#');
    ids[key] = (ids[key] || 0) + 1;
  });
  out.topIds = Object.entries(ids).sort((a, b) => b[1] - a[1]).slice(0, 40);
  // class histogram
  const cls = {};
  document.querySelectorAll('[class]').forEach((el) => {
    String(el.className).split(/\s+/).filter(Boolean).forEach((c) => {
      cls[c] = (cls[c] || 0) + 1;
    });
  });
  out.topClasses = Object.entries(cls).sort((a, b) => b[1] - a[1]).slice(0, 40);
  out.images = document.querySelectorAll('img').length;
  out.svg = document.querySelectorAll('svg').length;
  out.textNodes = document.querySelectorAll('div,p,span,h1,h2,h3,li,td,label,button,a').length;
  return out;
});
console.log('--- survey ---');
console.log(JSON.stringify(survey, null, 2));

// Accessibility tree
console.log('--- aria snapshot (root) ---');
try {
  const snap = await page.locator('body').ariaSnapshot({ timeout: 20000 });
  writeFileSync(`${OUT}/aria-snapshot.txt`, snap);
  console.log(snap.slice(0, 4000));
  console.log('... ariaSnapshot length', snap.length);
} catch (e) {
  console.log('ariaSnapshot ERR', String(e).slice(0, 500));
}

// Playwright aria snapshot
writeFileSync(`${OUT}/dom-html.html`, await page.content());
await page.screenshot({ path: `${OUT}/full.png`, fullPage: true });
await page.screenshot({ path: `${OUT}/viewport.png` });
console.log('--- screenshots written ---');

// Page dimensions
const dims = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  scrollH: document.documentElement.scrollHeight,
  clientW: document.documentElement.clientWidth,
  clientH: document.documentElement.clientHeight,
}));
console.log('--- dims ---', JSON.stringify(dims));

await browser.close();

