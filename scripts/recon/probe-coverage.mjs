import { chromium } from 'playwright';
import { DEFAULT_PAGE } from './_env.mjs';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(DEFAULT_PAGE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);
const main = page.frame({ name: 'mainFrame' });
const out = await main.evaluate(() => {
  const $ax = window.$axure;
  const r = {};
  const tryOne = (id) => {
    try {
      const v = $ax.getRectAndStyleById(id);
      if (!v) return null;
      const s = v.style || {};
      return { rect: v.rect, text: s.text, fill: s.fill, border: s.borderFill, borderWidth: s.borderWidth, radius: s.cornerRadius, visible: s.visible, limbo: s.limbo, fontSize: s.fontSize, fg: s.foreGroundFill, img: s.image, isFixed: v.rect && v.rect.isFixed };
    } catch (e) { return 'ERR ' + String(e).slice(0, 80); }
  };
  for (const id of ['u1', 'u3', 'u4', 'u4_state0', 'u4_state0_content', 'u5', 'u6', 'u9', 'u55', 'u55_input', 'u46', 'u47']) {
    r[id] = tryOne(id);
  }
  // how many widget ids exist, and does getRectAndStyleById cover all of them?
  const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id).filter((i) => /^u\d+$/.test(i));
  r.widgetCount = ids.length;
  let ok = 0, err = 0, nulls = 0;
  for (const id of ids) { const v = tryOne(id); if (v && v !== null && typeof v === 'object') ok++; else if (v === null) nulls++; else err++; }
  r.coverage = { ok, nulls, err, total: ids.length };
  return r;
});
console.log(JSON.stringify(out, null, 1).slice(0, 7000));
await browser.close();

