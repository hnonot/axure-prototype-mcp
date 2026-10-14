/**
 * Recon probe 7: full field dump of one widget that has an interactionMap.
 *
 * Establishes the model↔DOM id mapping and the exact action/expr vocabulary, so the reader and
 * decoder can be written against real data.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const PAGE = process.env.AXURE_PAGE || 'https://axure.example.com/ProjectB/%E8%AE%A2%E5%8D%95%E7%AE%A1%E7%90%86.html';
mkdirSync('recon-out', { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, bypassCSP: true });
await context.addInitScript(() => {
  const hook = () => {
    const ax = window.$axure;
    if (!ax || typeof ax.loadCurrentPage !== 'function' || ax.loadCurrentPage.__hooked) return false;
    const original = ax.loadCurrentPage;
    const wrapped = function () {
      try {
        window.__capturedPageModel = arguments[0];
      } catch (error) {
        /* ignore */
      }
      return original.apply(this, arguments);
    };
    wrapped.__hooked = true;
    ax.loadCurrentPage = wrapped;
    return true;
  };
  if (!hook()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (hook() || tries > 200) clearInterval(timer);
    }, 10);
  }
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
  const model = window.__capturedPageModel;
  if (!model) return { error: 'no captured model' };

  const safeStringify = (value, limit) => {
    const seen = new Set();
    const json = JSON.stringify(value, (key, val) => {
      if (key === 'parent') return undefined;
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[circular]';
        seen.add(val);
      }
      return val;
    });
    return json === undefined ? 'undefined' : json.slice(0, limit);
  };

  const out = { widgetsWithInteraction: [] };
  const visited = new Set();

  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 16) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value.interactionMap && typeof value.interactionMap === 'object' && Object.keys(value.interactionMap).length) {
      if (out.widgetsWithInteraction.length < 7) {
        const keys = Object.getOwnPropertyNames(value).filter((k) => k !== 'parent');
        const scalarFields = {};
        for (const key of keys) {
          const field = value[key];
          if (field === null || typeof field !== 'object') scalarFields[key] = String(field);
        }
        out.widgetsWithInteraction.push({
          allKeys: keys.slice(0, 40),
          scalarFields,
          interactionMap: safeStringify(value.interactionMap, 2200),
        });
      }
    }
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  };
  walk(model, 0);

  // Also: does the DOM expose any attribute linking back to a model id?
  const domAttributes = {};
  const base = document.getElementById('base');
  const first = base ? base.querySelector('[id^="u"]') : null;
  if (first) {
    for (const attribute of Array.from(first.attributes)) domAttributes[attribute.name] = attribute.value.slice(0, 80);
    out.domFirstWidget = { tag: first.tagName, id: first.id, attributes: domAttributes };
  }

  // And what does Axure's own runtime say maps an id? Try the query helper.
  try {
    const byId = window.$axure.getRectAndStyleById('u5');
    out.getRectAndStyleById_u5 = byId ? Object.keys(byId) : 'null';
  } catch (error) {
    out.getRectAndStyleById_u5 = 'threw';
  }
  return out;
});

console.log(JSON.stringify(report, null, 1).slice(0, 12000));
writeFileSync('recon-out/widget-full-dump.json', JSON.stringify(report, null, 1));
await browser.close();
