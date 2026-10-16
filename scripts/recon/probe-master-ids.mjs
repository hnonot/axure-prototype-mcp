/**
import { BASE } from './_env.mjs';
 * Probe 13: do masters carry their own `objectPaths`, and how do the 18 master interactions map to
 * DOM ids? The reader must walk `model.masters` too, and needs a hash→DOM-id map that covers master
 * widgets.
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
  const out = { domIdCount: domIds.size };
  out.modelHasObjectPaths = !!model.objectPaths;
  out.modelObjectPathsSize = model.objectPaths ? Object.keys(model.objectPaths).length : 0;

  const masterIds = model.masters ? Object.keys(model.masters) : [];
  out.masterCount = masterIds.length;

  // Build a merged hash→scriptId map from the model and every master, then test coverage.
  const merged = {};
  const addPaths = (paths) => {
    if (!paths) return 0;
    let added = 0;
    for (const [hash, entry] of Object.entries(paths)) {
      if (entry && entry.scriptId) {
        merged[hash] = entry.scriptId;
        added += 1;
      }
    }
    return added;
  };
  out.fromModel = addPaths(model.objectPaths);

  out.masterDetail = [];
  for (const masterId of masterIds) {
    const master = model.masters[masterId];
    const keys = master ? Object.getOwnPropertyNames(master) : [];
    const detail = { masterId: masterId.slice(0, 8), keys: keys.slice(0, 20) };
    detail.objectPathsSize = master && master.objectPaths ? Object.keys(master.objectPaths).length : 0;
    detail.ownScriptId = master && master.scriptId ? master.scriptId : null;
    out.masterDetail.push(detail);
    if (master && master.objectPaths) addPaths(master.objectPaths);
    // Some models nest objectPaths inside the diagram.
    if (master && master.diagram && master.diagram.objectPaths) addPaths(master.diagram.objectPaths);
    if (master) {
      // Also try any nested objectPaths-like map.
      for (const key of keys) {
        const value = master[key];
        if (value && typeof value === 'object' && !Array.isArray(value) && value !== master.objectPaths) {
          const sample = Object.values(value)[0];
          if (sample && typeof sample === 'object' && typeof sample.scriptId === 'string') {
            detail.nestedPathMap = key;
            addPaths(value);
          }
        }
      }
    }
  }

  out.mergedBridgeSize = Object.keys(merged).length;
  let inDom = 0;
  for (const scriptId of Object.values(merged)) if (domIds.has(scriptId)) inDom += 1;
  out.mergedInDom = inDom;

  // Coverage question: are the 18 interaction widgets resolvable through the merged map?
  const interactionHashes = [];
  const visited = new Set();
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 20 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value.interactionMap && Object.keys(value.interactionMap).length && value.id) interactionHashes.push(String(value.id));
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  };
  walk(model, 0);
  out.interactionWidgets = interactionHashes.length;
  out.resolvedViaMerged = interactionHashes.filter((hash) => merged[hash]).length;
  out.resolvedAndInDom = interactionHashes.filter((hash) => merged[hash] && domIds.has(merged[hash])).length;
  out.unresolvedSample = interactionHashes.filter((hash) => !merged[hash]).slice(0, 5);
  out.resolvedSample = interactionHashes
    .filter((hash) => merged[hash])
    .slice(0, 5)
    .map((hash) => ({ hash: hash.slice(0, 8), scriptId: merged[hash] }));
  return out;
});

console.log(JSON.stringify(report, null, 1).slice(0, 6000));
await browser.close();
