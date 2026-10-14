/**
 * Probe 12: where do the interaction-bearing widgets live in `model`, relative to the roots the
 * reader walks? On `版本更新记录` the reader walks `page.diagram.objects` and finds none, while a
 * full-model walk finds 18 cases — so the reader's roots are wrong for this page shape.
 */

import { chromium } from 'playwright';

const PAGE = 'https://axure.example.com/ProjectB/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.html';

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
  out.modelKeys = Object.getOwnPropertyNames(model);
  out.pageKeys = model.page ? Object.getOwnPropertyNames(model.page) : null;
  if (model.page && model.page.diagram) {
    out.diagramKeys = Object.getOwnPropertyNames(model.page.diagram);
    out.diagramObjectsLength = Array.isArray(model.page.diagram.objects) ? model.page.diagram.objects.length : null;
  }
  out.mastersKeys = model.masters ? Object.getOwnPropertyNames(model.masters).slice(0, 20) : null;

  // Record the path of every interaction-bearing object.
  const paths = [];
  const visited = new Set();
  const walk = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 20 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) walk(value[index], `${path}[${index}]`, depth + 1);
      return;
    }
    if (value.interactionMap && Object.keys(value.interactionMap).length) {
      paths.push({ path, id: value.id, type: value.friendlyType, events: Object.keys(value.interactionMap) });
    }
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') walk(child, `${path}.${key}`, depth + 1);
    }
  };
  walk(model, 'model', 0);

  out.interactionCount = paths.length;
  // Group by the top-level container that holds them.
  const containers = {};
  for (const entry of paths) {
    const key = entry.path.split('.').slice(0, 4).join('.');
    containers[key] = (containers[key] || 0) + 1;
  }
  out.containers = containers;
  out.samples = paths.slice(0, 6);
  return out;
});

console.log(JSON.stringify(report, null, 1).slice(0, 6000));
await browser.close();
