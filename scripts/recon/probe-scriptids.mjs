/**
import { BASE } from './_env.mjs';
 * Probe 15: do master widgets carry their DOM ids in `scriptIds`, and can a master's interaction
 * widgets be attributed that way?
 */

import { chromium } from 'playwright';

const PAGE = `${BASE}/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.html`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, bypassCSP: true });
await context.addInitScript(() => {
  const install = () => {
    const ax = window.$axure;
    if (!ax || typeof ax.loadCurrentPage !== 'function' || ax.loadCurrentPage.__axureMcpHooked) return false;
    const original = ax.loadCurrentPage;
    const wrapped = function () {
      try {
        window.__axureMcpPageModel = arguments[0];
      } catch (error) {
        /* ignore */
      }
      return original.apply(this, arguments);
    };
    wrapped.__axureMcpHooked = true;
    ax.loadCurrentPage = wrapped;
    return true;
  };
  if (install()) return;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (install() || attempts > 400) clearInterval(timer);
  }, 10);
});

const page = await context.newPage();
await page.goto(PAGE, { waitUntil: 'load', timeout: 60_000 });
await page.waitForTimeout(5000);

let frame = null;
for (const candidate of page.frames()) {
  const n = await candidate.evaluate(() => document.querySelectorAll('#base [id^="u"]').length).catch(() => 0);
  if (n > 0) frame = candidate;
}

const report = await frame.evaluate(() => {
  const model = window.__axureMcpPageModel;
  if (!model) return { error: 'not captured' };
  const domIds = new Set(Array.from(document.querySelectorAll('#base [id^="u"]')).map((el) => el.id));
  const out = { domIdCount: domIds.size, samples: [] };

  const visited = new Set();
  let checked = 0;
  let withScriptIds = 0;
  let scriptIdsThatMatchDom = 0;
  let scriptIdArrayShapes = {};

  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 20 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value.interactionMap && Object.keys(value.interactionMap).length) {
      checked += 1;
      const scriptIds = value.scriptIds;
      if (scriptIds !== undefined) {
        withScriptIds += 1;
        const shape = Array.isArray(scriptIds) ? 'array(' + scriptIds.length + ')' : typeof scriptIds;
        scriptIdArrayShapes[shape] = (scriptIdArrayShapes[shape] || 0) + 1;
        const candidates = Array.isArray(scriptIds)
          ? scriptIds
          : scriptIds && typeof scriptIds === 'object'
            ? Object.values(scriptIds)
            : [scriptIds];
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && domIds.has(candidate)) scriptIdsThatMatchDom += 1;
        }
        if (out.samples.length < 5) {
          out.samples.push({
            id: String(value.id).slice(0, 8),
            friendlyType: value.friendlyType,
            label: value.label,
            scriptIds: JSON.stringify(scriptIds).slice(0, 220),
          });
        }
      }
    }
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  };
  walk(model, 0);

  out.interactionWidgetsChecked = checked;
  out.withScriptIds = withScriptIds;
  out.scriptIdArrayShapes = scriptIdArrayShapes;
  out.scriptIdsThatMatchDom = scriptIdsThatMatchDom;

  // What does a page-level widget's scriptIds look like (for comparison)?
  const pageLevel = [];
  const collectPageLevel = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (item.interactionMap && item.id) {
        pageLevel.push({ id: String(item.id).slice(0, 8), scriptIds: JSON.stringify(item.scriptIds).slice(0, 160) });
      }
      if (Array.isArray(item.objs)) collectPageLevel(item.objs);
    }
  };
  const diagramObjects = model.page && model.page.diagram ? model.page.diagram.objects : null;
  collectPageLevel(diagramObjects);
  out.pageLevelWithScriptIds = pageLevel.slice(0, 4);
  return out;
});

console.log(JSON.stringify(report, null, 1).slice(0, 5000));
await browser.close();
