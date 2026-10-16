/**
import { BASE } from './_env.mjs';
 * Recon probe 5: find `interactionMap` in the captured model, cycle-safe.
 *
 * The object graph is cyclic (`parent` back-references), which defeated the previous probes. This
 * walks it with a visited set and reports the exact path and payload of every interaction-bearing
 * property, so the reader can be written against the real shape instead of a guess.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const PAGE = process.env.AXURE_PAGE || `\/%E8%AE%A2%E5%8D%95%E7%AE%A1%E7%90%86.html`;
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

  const INTERACTION_KEYS = ['interactionMap', 'interactions', 'events', 'eventMap', 'link', 'links',
    'onClick', 'onMouseEnter', 'onMouseLeave', 'onTextChange', 'onFocus', 'onLoad'];

  const visited = new Set();
  const hits = [];
  let objectCount = 0;
  const keyHistogram = {};
  let firstWidgetKeys = null;

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

  const walk = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 14) return;
    if (visited.has(value)) return;
    visited.add(value);
    objectCount += 1;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }

    const keys = Object.getOwnPropertyNames(value);
    if (path === 'model.page.objects[0]' || firstWidgetKeys === null) {
      if (path.startsWith('model.page.objects')) firstWidgetKeys = keys.slice(0, 50);
    }
    for (const key of keys) {
      keyHistogram[key] = (keyHistogram[key] || 0) + 1;
    }

    for (const key of INTERACTION_KEYS) {
      const payload = value[key];
      if (payload === undefined) continue;
      hits.push({
        path: `${path}.${key}`,
        widgetId: value.id !== undefined ? String(value.id) : undefined,
        label: value.label !== undefined ? String(value.label) : undefined,
        widgetType: value.type !== undefined ? String(value.type) : value.friendlyType,
        payloadKey: key,
        sample: safeStringify(payload, 900),
      });
    }

    for (const key of keys) {
      if (INTERACTION_KEYS.includes(key)) continue;
      if (key === 'parent') continue;
      let child;
      try {
        child = value[key];
      } catch (error) {
        continue;
      }
      if (child && typeof child === 'object') walk(child, `${path}.${key}`, depth + 1);
    }
  };

  walk(model, 'model', 0);

  return {
    objectCount,
    interactionHits: hits.length,
    distinctPayloadKeys: [...new Set(hits.map((hit) => hit.payloadKey))],
    topKeys: Object.entries(keyHistogram).sort((a, b) => b[1] - a[1]).slice(0, 40),
    firstWidgetKeys,
    samples: hits.slice(0, 8),
  };
});

console.log(JSON.stringify(report, null, 1).slice(0, 10000));
writeFileSync('recon-out/interaction-hits.json', JSON.stringify(report, null, 1));
await browser.close();
