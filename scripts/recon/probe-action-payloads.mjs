/**
 * Probe 16: the full raw payload of a `linkWindow` (Open Link) and a `setPanelState` action, so the
 * decoder can extract link destinations and panel state numbers instead of dropping them.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const PAGE = 'https://axure.example.com/ProjectB/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.html';
mkdirSync('recon-out', { recursive: true });

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
  const seen = { linkWindow: null, setPanelState: null };

  const safeStringify = (value, limit) => {
    const cache = new Set();
    const json = JSON.stringify(value, (key, val) => {
      if (key === 'parent') return undefined;
      if (val && typeof val === 'object') {
        if (cache.has(val)) return '[circular]';
        cache.add(val);
      }
      return val;
    });
    return json === undefined ? 'undefined' : json.slice(0, limit);
  };

  const visited = new Set();
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 22 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const map = value.interactionMap;
    if (map && typeof map === 'object') {
      for (const event of Object.values(map)) {
        for (const caseEntry of (event && event.cases) || []) {
          for (const action of (caseEntry && caseEntry.actions) || []) {
            if (!action || typeof action !== 'object') continue;
            if (action.action === 'linkWindow' && !seen.linkWindow) seen.linkWindow = safeStringify(action, 1800);
            if (action.action === 'setPanelState' && !seen.setPanelState) seen.setPanelState = safeStringify(action, 1800);
          }
        }
      }
    }
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  };
  walk(model, 0);

  // Also: what does the sitemap call these page ids? Capture the page ids present in the model.
  const sitemapPages = model.url ? String(model.url) : null;
  return { linkWindow: seen.linkWindow, setPanelState: seen.setPanelState, modelUrl: sitemapPages };
});

console.log('=== linkWindow ===');
console.log(report.linkWindow ?? '(not found)');
console.log('=== setPanelState ===');
console.log(report.setPanelState ?? '(not found)');
writeFileSync('recon-out/action-payloads.json', JSON.stringify(report, null, 1));
await browser.close();
