/**
 * Recon probe: where does Axure keep interaction data in the live deployment?
 *
 * This answers the one genuinely unknown input of the interaction feature. It is read-only and
 * prints structural facts, not conclusions.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PAGE = process.env.AXURE_PAGE || 'https://axure.example.com/ProjectB/%E8%AE%A2%E5%8D%95%E7%AE%A1%E7%90%86.html';
const OUT = 'recon-out';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, bypassCSP: true });
const page = await context.newPage();
await page.goto(PAGE, { waitUntil: 'load', timeout: 60_000 });
await page.waitForTimeout(5000);

let frame = null;
for (const candidate of page.frames()) {
  const n = await candidate.evaluate(() => document.querySelectorAll('#base [id^="u"]').length).catch(() => 0);
  if (n > 0) frame = candidate;
}
console.log('content frame:', frame ? frame.name() || '(main)' : 'NONE');
if (!frame) {
  await browser.close();
  process.exit(1);
}

const report = await frame.evaluate(() => {
  const ax = window.$axure;
  const out = { axureType: typeof ax, keys: [], shapes: {} };

  if (!ax) return out;
  out.keys = Object.getOwnPropertyNames(ax);

  // Describe each candidate container without dumping it.
  const describe = (label, value) => {
    if (value === undefined) {
      out.shapes[label] = 'undefined';
      return;
    }
    if (value === null) {
      out.shapes[label] = 'null';
      return;
    }
    const type = typeof value;
    if (type !== 'object') {
      out.shapes[label] = type;
      return;
    }
    const isArray = Array.isArray(value);
    let keys = [];
    try {
      keys = Object.getOwnPropertyNames(value).slice(0, 40);
    } catch (error) {
      keys = ['<threw>'];
    }
    out.shapes[label] = (isArray ? 'array len=' + value.length : 'object') + ' keys=' + JSON.stringify(keys);
  };

  describe('$axure.document', ax.document);
  describe('$axure.page', ax.page);
  describe('$axure.globals', ax.globals);
  if (ax.document) {
    for (const key of Object.getOwnPropertyNames(ax.document)) describe('document.' + key, ax.document[key]);
  }
  if (ax.page) {
    for (const key of Object.getOwnPropertyNames(ax.page)) describe('page.' + key, ax.page[0] || ax.page[key]);
  }

  // The page model is normally reachable through the loaded page data.
  try {
    if (ax.page && ax.page.page) describe('page.page', ax.page.page);
  } catch (error) {
    out.shapes['page.page'] = 'threw';
  }

  // Look for anything interaction-shaped anywhere shallowly reachable.
  const hits = [];
  const INTERACTION_HINTS = ['interaction', 'link', 'action', 'event', 'case'];
  const scan = (label, value, depth) => {
    if (depth > 3 || !value || typeof value !== 'object') return;
    let keys = [];
    try {
      keys = Object.getOwnPropertyNames(value);
    } catch (error) {
      return;
    }
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (INTERACTION_HINTS.some((hint) => lower.includes(hint))) {
        let child;
        try {
          child = value[key];
        } catch (error) {
          child = undefined;
        }
        const kind = Array.isArray(child) ? 'array(' + child.length + ')' : typeof child;
        hits.push(label + '.' + key + ' -> ' + kind);
      }
    }
    if (depth < 3) {
      for (const key of keys.slice(0, 25)) {
        let child;
        try {
          child = value[key];
        } catch (error) {
          continue;
        }
        if (child && typeof child === 'object') scan(label + '.' + key, child, depth + 1);
      }
    }
  };
  scan('$axure', ax, 0);
  out.interactionHits = hits.slice(0, 60);
  return out;
});

console.log(JSON.stringify(report, null, 1).slice(0, 8000));
writeFileSync(`${OUT}/interaction-model-probe.json`, JSON.stringify(report, null, 1));
await browser.close();
