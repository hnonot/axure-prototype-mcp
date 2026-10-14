/**
 * Recon probe 4: structure of `model.page.objects` in the captured Axure model.
 *
 * Probe 3 captured the decoded model through `$axure.loadCurrentPage`, but the interaction walk
 * bailed early. This prints the real shape of the page object graph so the reader can target it
 * exactly instead of guessing key names.
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

const shape = await frame.evaluate(() => {
  const model = window.__capturedPageModel;
  if (!model) return { error: 'no captured model' };
  const pageObj = model.page;
  const out = { pageKeys: pageObj ? Object.getOwnPropertyNames(pageObj).slice(0, 40) : null };

  const objects = pageObj && pageObj.objects;
  out.objectsType = Array.isArray(objects) ? 'array(' + objects.length + ')' : typeof objects;

  const keyHistogram = {};
  const sampleKeys = {};
  let counted = 0;

  const scan = (list, depth) => {
    if (!Array.isArray(list) || depth > 6) return;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      counted += 1;
      for (const key of Object.getOwnPropertyNames(item)) {
        keyHistogram[key] = (keyHistogram[key] || 0) + 1;
        if (!sampleKeys[key]) {
          let value;
          try {
            value = item[key];
          } catch (error) {
            value = undefined;
          }
          const kind = Array.isArray(value) ? 'array(' + value.length + ')' : typeof value;
          sampleKeys[key] = kind;
        }
      }
      if (Array.isArray(item.objects)) scan(item.objects, depth + 1);
    }
  };
  scan(objects, 0);

  out.countedObjects = counted;
  out.keyHistogram = Object.entries(keyHistogram).sort((a, b) => b[1] - a[1]).slice(0, 45);
  out.sampleKinds = sampleKeys;

  // Anything interaction-shaped anywhere in the page object?
  const hits = [];
  const INTERACTION_HINTS = ['interaction', 'link', 'action', 'event', 'case', 'onclick'];
  const strings = JSON.stringify(pageObj);
  for (const hint of INTERACTION_HINTS) {
    hits.push(hint + ': ' + (strings.split(hint).length - 1));
  }
  out.interactionHintCounts = hits;

  // A concrete widget sample for reference.
  if (Array.isArray(objects) && objects[0]) {
    out.firstObject = JSON.stringify(objects[0]).slice(0, 1500);
  }
  return out;
});

console.log(JSON.stringify(shape, null, 1).slice(0, 9000));
writeFileSync('recon-out/page-objects-shape.json', JSON.stringify(shape, null, 1));
await browser.close();
