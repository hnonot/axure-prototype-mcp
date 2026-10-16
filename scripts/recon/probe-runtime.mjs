import { chromium } from 'playwright';
import { DEFAULT_PAGE } from './_env.mjs';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(DEFAULT_PAGE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);
const out = await page.evaluate(() => {
  const w = window;
  const res = { hasAxure: typeof w.$axure, keys: w.$axure ? Object.keys(w.$axure).slice(0, 60) : null };
  res.docKeys = w.$axure && w.$axure.document ? Object.keys(w.$axure.document) : null;
  res.sitemap = w.$axure && w.$axure.document && w.$axure.document.sitemap
    ? JSON.stringify(w.$axure.document.sitemap).slice(0, 1500) : null;
  res.configuration = w.$axure && w.$axure.document && w.$axure.document.configuration
    ? JSON.stringify(w.$axure.document.configuration).slice(0, 800) : null;
  // per-page model (in the content frame this is where widgets live)
  return res;
});
console.log(JSON.stringify(out, null, 2));

const main = page.frame({ name: 'mainFrame' });
if (main) {
  const m = await main.evaluate(() => {
    const w = window;
    const res = {};
    res.hasAxure = typeof w.$axure;
    res.keys = w.$axure ? Object.keys(w.$axure).slice(0, 80) : null;
    res.pageKeys = w.$axure && w.$axure.page ? Object.keys(w.$axure.page) : null;
    res.hasPageData = !!(w.$axure && w.$axure.page && w.$axure.page.page);
    if (res.hasPageData) {
      const p = w.$axure.page.page;
      res.pageMeta = { packageId: p.packageId, id: p.id, url: p.url, pageName: p.pageName, type: p.type };
      res.topObjectKeys = Object.keys(p).slice(0, 60);
      const objs = w.$axure.page.page.objects;
      res.objectCount = Array.isArray(objs) ? objs.length : typeof objs;
      if (Array.isArray(objs) && objs[0]) {
        res.sampleObject = JSON.stringify(objs[0]).slice(0, 1200);
        const labels = objs.slice(0, 12).map((o) => ({ id: o.id, type: o.type, label: o.label, name: o.name, hasText: !!o.text }));
        res.firstObjects = labels;
      }
    }
    res.gv = w.$axure && w.$axure.globalVariables ? Object.keys(w.$axure.globalVariables).slice(0, 10) : null;
    return res;
  });
  console.log('=== main frame ===');
  console.log(JSON.stringify(m, null, 2));
}
await browser.close();

