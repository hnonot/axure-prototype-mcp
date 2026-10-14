/**
 * Probe 17: is the setPanelState panel hash present in `model.objectPaths`, and what are the real
 * `stateNumber` / authored-state relationships?
 */

import { chromium } from 'playwright';

const PAGE = 'https://axure.example.com/ProjectB/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.html';
const PANEL_HASH = 'c6c3f95eb74849d4b0e7834911edea3b';

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

const report = await frame.evaluate((panelHash) => {
  const model = window.__axureMcpPageModel;
  if (!model) return { error: 'not captured' };
  const out = {};

  // Is the panel hash in objectPaths?
  out.inObjectPaths = !!(model.objectPaths && model.objectPaths[panelHash]);
  out.objectPathsEntry = model.objectPaths && model.objectPaths[panelHash] ? JSON.stringify(model.objectPaths[panelHash]).slice(0, 300) : null;

  // Is it findable as a widget anywhere in the model, and what does it carry?
  let found = null;
  const visited = new Set();
  const walk = (value, path, depth) => {
    if (found || !value || typeof value !== 'object' || depth > 22 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (String(value.id) === panelHash) {
      found = {
        path,
        keys: Object.getOwnPropertyNames(value).filter((k) => k !== 'parent').slice(0, 30),
        scriptIds: JSON.stringify(value.scriptIds),
        friendlyType: value.friendlyType,
        label: value.label,
        stateCount: Array.isArray(value.diagrams) ? value.diagrams.length : undefined,
      };
    }
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') walk(child, `${path}.${key}`, depth + 1);
    }
  };
  walk(model, 'model', 0);
  out.widgetFound = found;

  // How does the DOM expose this panel? Look for a widget whose scriptIds map back.
  const domIds = Array.from(document.querySelectorAll('#base [id^="u"]')).map((el) => el.id);
  out.domIdCount = domIds.length;
  return out;
}, PANEL_HASH);

console.log(JSON.stringify(report, null, 1).slice(0, 4000));
await browser.close();
