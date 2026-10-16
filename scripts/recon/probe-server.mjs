import { loadConfig } from '../../dist/config.js';
import { BASE } from './_env.mjs';
import { BrowserPool, } from '../../dist/browser.js';
import { readSitemap } from '../../dist/axure-doc.js';
import { findContentFrame } from '../../dist/axure-page.js';

const config = loadConfig();
console.log('config', JSON.stringify({ baseUrl: config.baseUrl, settleMs: config.settleMs, defaultPageUrl: config.defaultPageUrl }));

const pool = new BrowserPool(config, (level, message, meta) => console.log(`[${level}] ${message}`, meta ?? ''));
const session = await pool.openSession();
const page = session.page;
page.on('framenavigated', (f) => console.log('framenavigated', f.name() || '(main)', f.url().slice(0, 120)));
const resp = await page.goto(config.defaultPageUrl, { waitUntil: 'load', timeout: 60000 });
console.log('status', resp && resp.status(), 'url', page.url());
await page.waitForTimeout(config.settleMs);

for (const f of page.frames()) {
  const state = await f.evaluate(() => {
    const ax = window.$axure;
    return {
      url: location.href,
      readyState: document.readyState,
      axureType: typeof ax,
      hasDoc: !!(ax && ax.document),
      sitemap: !!(ax && ax.document && ax.document.sitemap),
      base: !!document.getElementById('base'),
      widgetCount: document.querySelectorAll('[id^="u"]').length,
    };
  }).catch((e) => ({ err: String(e).slice(0, 200) }));
  console.log('frame', f.name() || '(main)', JSON.stringify(state));
}

try {
  const frame = await findContentFrame(page);
  console.log('content frame chosen:', frame.name() || '(main)', frame.url().slice(0, 120));
  const sitemap = await readSitemap(frame, config);
  console.log('sitemap OK pages=', sitemap.pageCount, 'project=', sitemap.projectName);
} catch (e) {
  console.log('ERR', String(e));
}
await session.dispose();
await pool.dispose();

