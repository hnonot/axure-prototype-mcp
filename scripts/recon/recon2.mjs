import { chromium } from 'playwright';
import { DEFAULT_PAGE } from './_env.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.env.OUT || './recon-out';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
await page.goto(DEFAULT_PAGE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(6000);
console.log('shell url', page.url(), 'title', await page.title());

// find the content frame
const frames = page.frames();
console.log('--- frames ---');
for (const f of frames) console.log(' ', f.name() || '(unnamed)', f.url().slice(0, 160));

const main = page.frame({ name: 'mainFrame' }) || page.frames().find((f) => f !== page.mainFrame());
console.log('--- main frame ---', main && main.url().slice(0, 200));

if (main) {
  const survey = await main.evaluate(() => {
    const out = {};
    out.url = location.href;
    out.title = document.title;
    out.totalElements = document.querySelectorAll('*').length;
    out.frames = Array.from(document.querySelectorAll('iframe')).map((f) => ({ id: f.id, name: f.name, src: f.getAttribute('src') }));
    const ids = {};
    document.querySelectorAll('[id]').forEach((el) => {
      ids[el.id.replace(/[0-9]+/g, '#')] = (ids[el.id.replace(/[0-9]+/g, '#')] || 0) + 1;
    });
    out.topIds = Object.entries(ids).sort((a, b) => b[1] - a[1]).slice(0, 30);
    const cls = {};
    document.querySelectorAll('[class]').forEach((el) => {
      String(el.className).split(/\s+/).filter(Boolean).forEach((c) => { cls[c] = (cls[c] || 0) + 1; });
    });
    out.topClasses = Object.entries(cls).sort((a, b) => b[1] - a[1]).slice(0, 30);
    out.texts = Array.from(document.querySelectorAll('*'))
      .filter((el) => el.children.length === 0 && el.textContent && el.textContent.trim())
      .slice(0, 60)
      .map((el) => ({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 60), text: el.textContent.trim().slice(0, 80) }));
    out.dims = { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight };
    return out;
  });
  console.log('--- main survey ---');
  console.log(JSON.stringify(survey, null, 2));

  try {
    const snap = await main.locator('body').ariaSnapshot({ timeout: 30000 });
    writeFileSync(`${OUT}/aria-main.txt`, snap);
    console.log('--- aria snapshot len', snap.length, '---');
    console.log(snap.slice(0, 6000));
  } catch (e) {
    console.log('aria ERR', String(e).slice(0, 400));
  }

  writeFileSync(`${OUT}/main.html`, await main.content());
  await main.locator('body').screenshot({ path: `${OUT}/main-body.png` }).catch((e) => console.log('body shot err', String(e).slice(0, 200)));
}
await page.screenshot({ path: `${OUT}/shell.png` });
await browser.close();

