import { chromium } from 'playwright';
const URL_ = process.env.AXURE_URL || 'https://axure.example.com/ProjectB';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });
for (const wait of [0, 500, 1000, 2000, 3000, 5000, 8000]) {
  if (wait) await page.waitForTimeout(wait - (wait === 500 ? 0 : 0));
  const state = await page.evaluate(() => {
    const ax = window.$axure;
    return {
      axureType: typeof ax,
      hasDocument: !!(ax && ax.document),
      isLoaded: !!(ax && ax.document && ax.document.isLoaded),
      sitemap: !!(ax && ax.document && ax.document.sitemap),
      rootNodes: ax && ax.document && ax.document.sitemap ? (ax.document.sitemap.rootNodes || []).length : -1,
      baseEl: !!document.getElementById('base'),
      baseChildren: document.getElementById('base') ? document.getElementById('base').children.length : -1,
      playerReady: !!(ax && ax.player),
    };
  });
  console.log(`t≈${wait}ms`, JSON.stringify(state));
}
await browser.close();

