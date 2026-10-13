import { chromium } from 'playwright';
const URL_ = process.env.AXURE_URL || 'https://axure.example.com/ProjectB';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);
const main = page.frame({ name: 'mainFrame' });

const out = await main.evaluate(() => {
  const r = {};
  r.windowKeys = Object.keys(window).filter((k) => /ax|page|doc|diag|obj|player/i.test(k)).slice(0, 40);
  // walk the $axure namespace shallowly, reporting non-enumerable + nested keys
  const describe = (obj, path, depth) => {
    if (!obj || depth > 3) return null;
    const res = {};
    let keys = [];
    try { keys = Object.getOwnPropertyNames(obj); } catch { return null; }
    for (const k of keys.slice(0, 200)) {
      try {
        const v = obj[k];
        const t = typeof v;
        if (t === 'function') { res[k] = 'fn'; continue; }
        if (v && t === 'object') {
          const sub = describe(v, `${path}.${k}`, depth + 1);
          res[k] = sub ?? 'obj';
        } else { res[k] = String(v).slice(0, 60); }
      } catch (e) { res[k] = 'ERR'; }
    }
    return res;
  };
  r.ns = describe(window.$axure, '$axure', 0);
  return r;
});
console.log(JSON.stringify(out, null, 1).slice(0, 12000));
await browser.close();

