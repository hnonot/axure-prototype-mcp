/**
 * Recon probe 3: capture the decoded current-page model through Axure's own loader.
 *
 * `files/<name>/data.js` is minified but passes **real property names** into
 * `$axure.loadCurrentPage(...)`. Intercepting that call is therefore far more robust than parsing
 * the obfuscated source: the argument is the fully decoded model.
 *
 * Uses `addInitScript` so the hook is installed before any page script runs.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const PAGE = process.env.AXURE_PAGE || 'https://axure.example.com/ProjectB/%E8%AE%A2%E5%8D%95%E7%AE%A1%E7%90%86.html';
mkdirSync('recon-out', { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, bypassCSP: true });

// Install the hook in the main frame AND every future child frame, before page scripts run.
await context.addInitScript(() => {
  const hook = () => {
    const ax = window.$axure;
    if (!ax || typeof ax.loadCurrentPage !== 'function' || ax.loadCurrentPage.__hooked) return false;
    const original = ax.loadCurrentPage;
    const wrapped = function () {
      const model = arguments[0];
      try {
        window.__capturedPageModel = model;
      } catch (error) {
        /* ignore */
      }
      return original.apply(this, arguments);
    };
    wrapped.__hooked = true;
    ax.loadCurrentPage = wrapped;
    return true;
  };
  // `$axure` may not exist yet when this runs, so poll briefly.
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
if (!frame) {
  console.log('no content frame');
  await browser.close();
  process.exit(1);
}

const captured = await frame.evaluate(() => {
  const model = window.__capturedPageModel;
  if (!model) return { captured: false };
  const out = { captured: true, type: typeof model, keys: Object.getOwnPropertyNames(model).slice(0, 60) };
  if (typeof model === 'object' && model !== null) {
    out.objectsIsArray = Array.isArray(model.objects);
    out.objectsLength = Array.isArray(model.objects) ? model.objects.length : undefined;
    if (Array.isArray(model.objects) && model.objects[0]) {
      out.firstObjectKeys = Object.getOwnPropertyNames(model.objects[0]).slice(0, 40);
      out.firstObjectSample = JSON.stringify(model.objects[0]).slice(0, 1200);
    }
  }
  return out;
});

console.log('=== captured model ===');
console.log(JSON.stringify(captured, null, 1).slice(0, 6000));

// Walk the captured model for interaction-bearing objects.
const interactions = await frame.evaluate(() => {
  const model = window.__capturedPageModel;
  if (!model) return { error: 'no model' };
  const INTERACTION_KEYS = ['interactionMap', 'interactions', 'events', 'eventMap', 'link', 'links',
    'onClick', 'onMouseEnter', 'onMouseLeave', 'onTextChange'];

  const found = [];
  let visited = 0;
  const seenInteractionPayloads = new Set();

  const walk = (value, path, depth) => {
    if (depth > 12 || visited > 60000 || !value || typeof value !== 'object') return;
    visited += 1;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i], path + '[' + i + ']', depth + 1);
      return;
    }
    const hasAny = INTERACTION_KEYS.some((k) => value[k] !== undefined);
    if (hasAny && value.id !== undefined) {
      const payload = {};
      for (const k of INTERACTION_KEYS) if (value[k] !== undefined) payload[k] = value[k];
      found.push({
        id: String(value.id),
        label: value.label !== undefined ? String(value.label) : undefined,
        type: value.type !== undefined ? String(value.type) : value.friendlyType,
        keys: Object.keys(payload),
        // One compact sample per event key, so we can see the real shape.
        sample: JSON.stringify(payload).slice(0, 700),
      });
      for (const k of Object.keys(payload)) seenInteractionPayloads.add(k);
    }
    for (const key of Object.keys(value)) {
      if (INTERACTION_KEYS.includes(key)) continue;
      const child = value[key];
      if (child && typeof child === 'object') walk(child, path + '.' + key, depth + 1);
    }
  };

  walk(model, 'model', 0);
  return {
    visited,
    objectsWithInteractions: found.length,
    payloadKeysSeen: [...seenInteractionPayloads],
    samples: found.slice(0, 6),
  };
});

console.log('=== interactions found in the captured model ===');
console.log(JSON.stringify(interactions, null, 1).slice(0, 7000));
writeFileSync('recon-out/interaction-model-capture.json', JSON.stringify({ captured, interactions }, null, 1));

await browser.close();
