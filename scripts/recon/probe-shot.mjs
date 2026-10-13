import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL_ = process.env.AXURE_URL || 'https://axure.example.com/ProjectB';
const PAGE = 'https://axure.example.com/ProjectB/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.html';
const pngSize = (b) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

const browser = await chromium.launch({ headless: true });

const contentFrame = async (page) => {
  for (let i = 0; i < 60; i += 1) {
    for (const f of page.frames()) {
      const n = await f.evaluate(() => document.querySelectorAll('#base [id^="u"]').length).catch(() => 0);
      if (n > 0) return f;
    }
    await page.waitForTimeout(250);
  }
  return null;
};

for (const target of [PAGE, URL_]) {
  for (const vp of [{ width: 1440, height: 900 }, { width: 1920, height: 1200 }]) {
    const ctx = await browser.newContext({ viewport: vp, bypassCSP: true });
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(4000);
    const frame = await contentFrame(page);
    console.log(`\n=== ${target === PAGE ? 'direct' : 'root'} @ ${vp.width}x${vp.height} === frame=${frame ? (frame.name() || '(main)') : 'NONE'}`);
    if (!frame) { await ctx.close(); continue; }

    const shell = await page.evaluate(() => {
      const f = document.getElementById('mainFrame');
      const r = f ? f.getBoundingClientRect() : null;
      return {
        frameRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        shell: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight },
      };
    });
    const inner = await frame.evaluate(() => {
      const b = document.body.getBoundingClientRect();
      let axure = null;
      try { const s = window.$axure.getPageSize(); axure = { width: s.width, height: s.height }; } catch { axure = null; }
      const base = document.getElementById('base');
      return {
        bodyRect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
        html: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight },
        axure,
        base: base ? { w: base.offsetWidth, h: base.offsetHeight } : null,
      };
    });
    console.log('shell ', JSON.stringify(shell));
    console.log('inner ', JSON.stringify(inner));

    const strategies = {};
    const attempt = async (name, fn) => { try { strategies[name] = pngSize(await fn()); } catch (e) { strategies[name] = 'ERR ' + String(e.message).slice(0, 50); } };
    await attempt('page:fullPage', () => page.screenshot({ type: 'png', fullPage: true }));
    await attempt('page:viewport', () => page.screenshot({ type: 'png' }));
    if (shell.frameRect) {
      await attempt('frameElement', () => page.locator('#mainFrame').screenshot({ type: 'png' }));
      await attempt('page:clipFrameRect', () => page.screenshot({ type: 'png', clip: shell.frameRect }));
    }
    await attempt('frameBodyBox', async () => {
      const box = await frame.locator('body').boundingBox();
      return page.screenshot({ type: 'png', clip: box });
    });
    console.log('shots ', JSON.stringify(strategies));
    if (vp.width === 1440 && target === PAGE) writeFileSync('../../recon-out/shot-fullpage.png', await page.screenshot({ type: 'png', fullPage: true }));
    await ctx.close();
  }
}
await browser.close();

