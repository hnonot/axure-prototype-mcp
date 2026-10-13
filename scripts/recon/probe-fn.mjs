import { chromium } from 'playwright';
const URL_ = process.env.AXURE_URL || 'https://axure.example.com/ProjectB';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);
const main = page.frame({ name: 'mainFrame' });

const out = await main.evaluate(() => {
  const $ax = window.$axure;
  const r = {};
  try {
    const ids = $ax.fn.getElementIds();
    r.elementIdCount = Array.isArray(ids) ? ids.length : typeof ids;
    r.firstIds = Array.isArray(ids) ? ids.slice(0, 30) : String(ids).slice(0, 300);
  } catch (e) { r.idsErr = String(e); }
  try { r.queryKeys = Object.keys($ax.query); } catch (e) { r.queryErr = String(e); }
  // Try the jQuery-ish layer accessor for one widget
  try {
    const el = $ax.fn.getElements('u5');
    r.getElementsU5 = { len: el && el.length, type: typeof el };
  } catch (e) { r.geErr = String(e); }
  try {
    r.jobj = typeof window.$jobj;
    const j = window.$jobj('u5');
    r.jobjU5 = j ? { len: j.length, children: j.children && j.children().length } : null;
    if (j && j.length) {
      r.jobjU5type = $ax.fn.IsDynamicPanel ? [$ax.fn.IsDynamicPanel('u5'), $ax.fn.IsContainer('u5'), $ax.fn.IsPage ? undefined : undefined] : null;
      r.textU5 = $ax.fn.text('u5');
      r.rectU5 = JSON.stringify($ax.fn.pageBoundingRect('u5'));
      r.vpRectU5 = JSON.stringify($ax.fn.viewportBoundingRect('u5'));
      r.offsetLocU5 = JSON.stringify($ax.fn.offsetLocation('u5'));
    }
  } catch (e) { r.jobjErr = String(e); }
  try {
    r.isDynU4 = $ax.fn.IsDynamicPanel('u4');
    r.isContainerU4 = $ax.fn.IsContainer('u4');
    r.isGroupU1 = $ax.fn.IsContainer('u1');
    r.childrenU4 = $ax.fn.getChildren ? JSON.stringify($ax.fn.getChildren('u4')) : null;
    r.parentU5 = JSON.stringify($ax.fn.getParents('u5'));
    r.deepU4 = $ax.fn.getLayerChildrenDeep ? JSON.stringify($ax.fn.getLayerChildrenDeep('u4')) : null;
  } catch (e) { r.moreErr = String(e); }
  try { r.getPageSize = JSON.stringify($ax.fn.getPageSize()); } catch (e) { r.psErr = String(e); }
  return r;
});
console.log(JSON.stringify(out, null, 1).slice(0, 8000));
await browser.close();

