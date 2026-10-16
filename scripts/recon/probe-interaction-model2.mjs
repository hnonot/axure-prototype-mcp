/**
import { BASE } from './_env.mjs';
 * Recon probe 2: locate the current page's interaction model.
 *
 * Probe 1 showed `$axure` in the content frame is a *function* with no `.document`. This narrows
 * the search: inspect the namespace as an object, the per-widget accessors, and the page's own
 * `files/<name>/data.js`, which is where Axure exports the current page model.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const PAGE = process.env.AXURE_PAGE || `\/%E8%AE%A2%E5%8D%95%E7%AE%A1%E7%90%86.html`;
mkdirSync('recon-out', { recursive: true });

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
if (!frame) {
  console.log('no content frame');
  await browser.close();
  process.exit(1);
}

// 1) What scripts does the page load? The per-page data file is the interesting one.
const scripts = await frame.evaluate(() => Array.from(document.scripts).map((s) => s.src).filter(Boolean));
console.log('=== scripts ===');
console.log(scripts.map((s) => s.replace(/^https?:\/\/[^/]+/, '')).join('\n'));

// 2) Probe the namespace as an object.
const ns = await frame.evaluate(() => {
  const ax = window.$axure;
  const out = {};
  const member = (label, value) => {
    if (value === undefined) out[label] = 'undefined';
    else if (value === null) out[label] = 'null';
    else if (typeof value === 'function') out[label] = 'function(arity=' + value.length + ')';
    else if (Array.isArray(value)) out[label] = 'array(' + value.length + ')';
    else out[label] = typeof value;
  };
  member('fn', ax.fn);
  member('internal', ax.internal);
  member('query', ax.query);
  member('page', ax.page);
  member('$obj', window.$obj);
  member('$jobj', window.$jobj);
  member('$axure.fn.getLayerChildrenDeep', ax.fn && ax.fn.getLayerChildrenDeep);
  member('$axure.fn.getChildren', ax.fn && ax.fn.getChildren);
  member('$axure.fn.getElements', ax.fn && ax.fn.getElements);

  // Does a widget accessor carry interaction data?
  try {
    const obj = window.$obj ? window.$obj('u5') : null;
    if (obj) {
      out.$obj_u5 = { length: obj.length, ownKeys: Object.getOwnPropertyNames(obj).slice(0, 20) };
      const inner = obj[0] || obj;
      out.$obj_u5_inner = inner && typeof inner === 'object' ? Object.getOwnPropertyNames(inner).slice(0, 30) : String(inner);
    } else {
      out.$obj_u5 = 'null';
    }
  } catch (error) {
    out.$obj_u5 = 'threw: ' + String(error);
  }

  // jQuery data attached to a widget often holds the event map.
  try {
    const jq = window.$jobj ? window.$jobj('u5') : null;
    if (jq && jq.length) {
      const events = window.jQuery ? window.jQuery._data(jq[0], 'events') : null;
      out.jquery_events_u5 = events ? Object.keys(events) : 'none';
    }
  } catch (error) {
    out.jquery_events_u5 = 'threw: ' + String(error);
  }
  return out;
});
console.log('=== namespace ===');
console.log(JSON.stringify(ns, null, 1));

// 3) Fetch the page's own data file and inspect its shape.
const dataUrl = await frame.evaluate(() => {
  const scripts = Array.from(document.scripts).map((s) => s.getAttribute('src') || '');
  const match = scripts.find((src) => /files\/.*\/data\.js$/.test(src));
  return match ? new URL(match, location.href).toString() : null;
});
console.log('=== page data file ===');
console.log(dataUrl ?? 'NOT FOUND');

if (dataUrl) {
  const response = await fetch(dataUrl);
  const text = await response.text();
  writeFileSync('recon-out/page-data.js', text);
  console.log('length:', text.length);
  console.log('--- first 600 chars ---');
  console.log(text.slice(0, 600));
  // Which interaction-ish identifiers appear?
  const hints = ['interactionMap', 'interactions', 'onClick', 'onMouseEnter', 'friendlyType', 'action',
    'cases', 'caseName', 'targetIds', 'setPanelState', 'navigate', 'objects', 'diagram'];
  console.log('--- identifier presence ---');
  for (const hint of hints) {
    const count = text.split(hint).length - 1;
    console.log(`  ${hint}: ${count}`);
  }
}

await browser.close();
