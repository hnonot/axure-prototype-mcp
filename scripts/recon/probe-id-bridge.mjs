/**
 * Recon probe 8: bridge the model's 32-char widget hashes to the DOM's `u<N>` ids.
 *
 * The outline addresses widgets as `u<N>`; the interaction model keys them by hash. Without a
 * mapping, an interaction cannot be attributed to a widget the page map describes, which would
 * make the feature useless. This probe looks for the bridge in the model and in the runtime.
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
  const ax = window.$axure;
  const out = {};

  // 1. Does the DOM carry the hash anywhere (attribute, jQuery data, expando)?
  const el = document.getElementById('u575');
  if (el) {
    out.u575_attributes = {};
    for (const attribute of Array.from(el.attributes)) out.u575_attributes[attribute.name] = attribute.value.slice(0, 60);
    out.u575_ownProps = Object.getOwnPropertyNames(el).filter((k) => !k.startsWith('on')).slice(0, 30);
    // jQuery data attached by Axure.
    if (window.jQuery) {
      const data = window.jQuery._data ? window.jQuery._data(el) : null;
      out.u575_jqueryDataKeys = data ? Object.keys(data).slice(0, 30) : 'none';
      const events = window.jQuery._data ? window.jQuery._data(el, 'events') : null;
      out.u575_events = events ? Object.keys(events) : 'none';
    }
  }

  // 2. Axure runtime id/path helpers.
  const helperNames = ['getIdFromPath', 'getPathFromId', 'getObjectIdFromPath', 'getPathFromObjectId',
    'getElementIdFromPath', 'getScriptId', 'getPath', 'getObjectId', 'getElementId'];
  out.helpers = {};
  for (const name of helperNames) {
    out.helpers[name] = typeof ax[name];
    if (typeof ax[name] !== 'function') {
      for (const namespace of ['fn', 'internal', 'query', 'utils']) {
        if (ax[namespace] && typeof ax[namespace][name] === 'function') out.helpers[name] = namespace + '.' + name;
      }
    }
  }
  out.fnKeys = ax.fn ? Object.getOwnPropertyNames(ax.fn).filter((k) => /id|path|object/i.test(k)).slice(0, 30) : null;
  out.internalType = typeof ax.internal;

  // 3. Model mapping structures.
  const model = window.__capturedPageModel;
  const pageObj = model && model.page;
  out.modelTopKeys = model ? Object.getOwnPropertyNames(model).slice(0, 30) : null;
  out.pageKeys = pageObj ? Object.getOwnPropertyNames(pageObj).slice(0, 30) : null;

  if (pageObj) {
    const describe = (label, value) => {
      if (value === undefined) out[label] = 'undefined';
      else if (Array.isArray(value)) out[label] = 'array(' + value.length + ')';
      else if (value && typeof value === 'object') out[label] = 'object keys=' + JSON.stringify(Object.getOwnPropertyNames(value).slice(0, 20));
      else out[label] = typeof value;
    };
    describe('page.scriptIds', pageObj.scriptIds);
    describe('page.objectPaths', pageObj.objectPaths);
    describe('page.idToPath', pageObj.idToPath);
    describe('page.pathToId', pageObj.pathToId);
    describe('page.objects', pageObj.objects);
    describe('page.diagram', pageObj.diagram);
    if (pageObj.diagram) {
      describe('page.diagram.objects', pageObj.diagram.objects);
      describe('page.diagram.scriptIds', pageObj.diagram.scriptIds);
      out.diagramKeys = Object.getOwnPropertyNames(pageObj.diagram).slice(0, 30);
    }
  }

  // 4. Look for any object in the model whose value is a short `u<N>` string.
  const uMatches = [];
  const visited = new Set();
  const walk = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 10 || uMatches.length > 12) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i], path + '[' + i + ']', depth + 1);
      return;
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (typeof child === 'string' && /^u\d+$/.test(child)) {
        uMatches.push({ path: path + '.' + key, value: child });
      } else if (child && typeof child === 'object' && key !== 'parent') {
        walk(child, path + '.' + key, depth + 1);
      }
    }
  };
  if (model) walk(model, 'model', 0);
  out.uIdMatchesInModel = uMatches;
  return out;
});

console.log(JSON.stringify(report, null, 1).slice(0, 9000));
writeFileSync('recon-out/id-bridge.json', JSON.stringify(report, null, 1));
await browser.close();
