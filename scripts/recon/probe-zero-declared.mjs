/**
 * Probe 11: isolate why the tool reports 0 declared interactions on `版本更新记录` while the
 * survey found 18 cases. Compares three things on the same page load:
 *
 *   1. whether the adapter's capture hook produced `window.__axureMcpPageModel`
 *   2. the raw number of widgets carrying an interactionMap in that captured model
 *   3. what the built reader returns when run against the same page
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PAGE = 'https://axure.example.com/ProjectB/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.html';

// Use the same source the server compiles (read from TypeScript, as the reader test does).
const src = readFileSync('src/axure/interaction-source.ts', 'utf8');
const start = src.indexOf('export const INTERACTION_SOURCE = `');
const bodyStart = src.indexOf('`', start) + 1;
const bodyEnd = src.lastIndexOf('`;');
if (start < 0 || bodyEnd <= bodyStart) throw new Error('could not extract INTERACTION_SOURCE');
const SOURCE = src.slice(bodyStart, bodyEnd);
console.log('reader source length:', SOURCE.length);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, bypassCSP: true });

// Install the same hook the adapter installs.
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
console.log('content frame:', frame ? frame.name() || '(main)' : 'NONE');

// 1 + 2: capture and raw count.
const capture = await frame.evaluate(() => {
  const model = window.__axureMcpPageModel;
  if (!model) return { captured: false };
  const objectPaths = model.objectPaths || {};
  const hashToScript = {};
  for (const [hash, entry] of Object.entries(objectPaths)) {
    if (entry && entry.scriptId) hashToScript[hash] = entry.scriptId;
  }
  const diagram = model.page && model.page.diagram;
  const roots = diagram && Array.isArray(diagram.objects) ? diagram.objects : [];
  const withMap = [];
  const visited = new Set();
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 20 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value.interactionMap && Object.keys(value.interactionMap).length) {
      withMap.push({
        id: value.id,
        scriptId: hashToScript[value.id],
        friendlyType: value.friendlyType,
        eventKeys: Object.keys(value.interactionMap),
      });
    }
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  };
  walk(roots, 0);
  return {
    captured: true,
    idBridge: Object.keys(hashToScript).length,
    objectPathsCount: Object.keys(objectPaths).length,
    interactionWidgets: withMap.length,
    sample: withMap.slice(0, 5),
  };
});
console.log('capture:', JSON.stringify(capture, null, 1).slice(0, 2500));

// 3: run the actual reader.
const readerResult = await frame.evaluate(
  ({ declaration }) => {
    const factory = new Function(`${declaration}; return axureExtractOutline;`)();
    return factory({ maxWidgets: 400 });
  },
  { declaration: SOURCE },
);
console.log('reader result:', JSON.stringify({
  modelCaptured: readerResult.modelCaptured,
  idBridgeSize: readerResult.idBridgeSize,
  entries: readerResult.entries.length,
  gaps: readerResult.gaps,
  warnings: readerResult.warnings,
  firstEntry: readerResult.entries[0],
}, null, 1).slice(0, 3000));

await browser.close();
