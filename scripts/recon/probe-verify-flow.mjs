import { chromium } from 'playwright';
import { BASE } from './_env.mjs';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, bypassCSP: true });
const page = await ctx.newPage();
for (const url of [BASE, `${BASE}/`]) {
  try {
    const r = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(4000);
    const frames = page.frames();
    const probes = await Promise.all(frames.map(async (f) => {
      try {
        return await f.evaluate(() => ({
          url: location.href,
          hasAxure: typeof window.$axure !== 'undefined' && window.$axure !== null,
          hasBase: !!document.getElementById('base'),
        }));
      } catch (e) { return { error: String(e).slice(0, 60) }; }
    }));
    console.log(`\n${url} -> status ${r?.status()}`);
    console.log('  frames:', frames.length);
    for (const p of probes) console.log('   ', JSON.stringify(p));
  } catch (e) {
    console.log(`\n${url} -> 失败: ${String(e).slice(0, 120)}`);
  }
}
await browser.close();
