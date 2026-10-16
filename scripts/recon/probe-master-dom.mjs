/**
import { BASE } from './_env.mjs';
 * Probe 14: how are *master* widgets addressed in the DOM?
 *
 * The model's own `objectPaths` covers page-level widgets (57) but the master has none, so the 18
 * interactions inside the master cannot be attributed. This looks for the mapping in the master's
 * diagram, in the rendered markup, and in Axure's runtime id helpers.
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
  const out = {};

  // 1. Find the master's interaction widget ids and whether the DOM contains them at all.
  const masterId = Object.keys(model.masters || {})[0];
  const master = model.masters[masterId];
  const masterWidgetIds = [];
  const visited = new Set();
  const collect = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 20 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    if (value.interactionMap && Object.keys(value.interactionMap).length && value.id) masterWidgetIds.push(String(value.id));
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') collect(child, depth + 1);
    }
  };
  collect(master, 0);
  out.masterInteractionIds = masterWidgetIds.length;
  out.masterIdPrefix = masterId.slice(0, 8);
  out.domContainsRawId = masterWidgetIds.filter((id) => document.getElementById(id) !== null).length;

  // 2. Do any DOM ids look like they embed a model hash?
  const domIds = Array.from(document.querySelectorAll('#base [id^="u"]')).map((el) => el.id);
  out.domIdSamples = domIds.slice(0, 8);
  const hashes = new Set(Object.keys(model.objectPaths || {}));
  out.domIdsMentioningSomeHash = domIds.filter((id) => [...hashes].some((hash) => id.includes(hash))).length;

  // 3. The master's diagram may expose scriptIds after render.
  const masterDiagram = master && master.diagram;
  if (masterDiagram) {
    out.masterDiagramKeys = Object.getOwnPropertyNames(masterDiagram).slice(0, 20);
    const first = Array.isArray(masterDiagram.objects) ? masterDiagram.objects[0] : null;
    if (first) {
      out.firstMasterObjectKeys = Object.getOwnPropertyNames(first).slice(0, 30);
      out.firstMasterObjectScalars = Object.fromEntries(
        Object.getOwnPropertyNames(first)
          .filter((key) => {
            const value = first[key];
            return value === null || typeof value !== 'object';
          })
          .map((key) => [key, String(first[key])]),
      );
    }
  }

  // 4. Axure runtime helpers that might resolve a master object id.
  const ax = window.$axure;
  out.runtimeHelperNames = Object.getOwnPropertyNames(ax).filter((name) => /id|path|object|script/i.test(name));
  const fnKeyNames = ax.fn ? Object.getOwnPropertyNames(ax.fn).filter((name) => /id|path|object|script/i.test(name)) : [];
  out.fnHelperNames = fnKeyNames;
  out.$objAvailable = typeof window.$obj === 'function';
  if (out.$objAvailable) {
    try {
      out.$objOfFirstMasterId = String(typeof window.$obj(masterWidgetIds[0]));
    } catch (error) {
      out.$objOfFirstMasterId = 'threw: ' + String(error);
    }
  }

  // 5. Does one of the master's widgets appear with a data-label we can use?
  const masterLabels = [];
  const collectLabels = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 20) return;
    if (value.interactionMap && value.label) masterLabels.push(String(value.label));
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') collectLabels(child, depth + 1);
    }
  };
  collectLabels(master, 0);
  out.masterInteractionLabels = masterLabels.slice(0, 6);
  return out;
});

console.log(JSON.stringify(report, null, 1).slice(0, 6000));
await browser.close();
