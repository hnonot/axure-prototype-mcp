import { chromium } from 'playwright';
import { DEFAULT_PAGE } from './_env.mjs';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(DEFAULT_PAGE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);
const main = page.frame({ name: 'mainFrame' });

const probe = await main.evaluate(() => {
  const ax = window.$axure;
  const out = { internalKeys: Object.keys(ax.internal).slice(0, 80) };
  out.getRectAndStyleById = typeof ax.getRectAndStyleById;
  try { out.rectU5 = JSON.stringify(ax.getRectAndStyleById('u5')); } catch (e) { out.rectU5Err = String(e).slice(0, 200); }
  try { out.rectU4 = JSON.stringify(ax.getRectAndStyleById('u4')); } catch (e) { out.rectU4Err = String(e).slice(0, 200); }
  try { out.rectText = JSON.stringify(ax.getRectAndStyleById('u5_text')); } catch (e) { out.rectTextErr = String(e).slice(0, 200); }
  try { out.vis = [ax.isIdVisible('u5'), ax.isIdVisible('u4_state0'), ax.isIdVisible('u4_state1')]; } catch (e) { out.visErr = String(e).slice(0, 200); }
  try { out.parent = ax.getParentElementById('u5'); } catch (e) { out.parentErr = String(e).slice(0, 200); }
  try { out.atLoc = JSON.stringify(ax.getListOfIdAndRectAtLoc({ x: 100, y: 100 })); } catch (e) { out.atLocErr = String(e).slice(0, 200); }
  return out;
});
console.log('=== runtime API ===');
console.log(JSON.stringify(probe, null, 2));

const model = await main.evaluate(() => {
  const ax = window.$axure;
  const i = ax.internal;
  const res = { iKeys: Object.keys(i) };
  const probeObj = (name) => {
    if (!i[name]) return null;
    try { return Object.keys(i[name]).slice(0, 60); } catch { return 'n/a'; }
  };
  res.objMgr = probeObj('obj');
  res.page = probeObj('page');
  res.diagram = probeObj('diagram');
  return res;
});
console.log('=== internal model ===');
console.log(JSON.stringify(model, null, 2));
await browser.close();

