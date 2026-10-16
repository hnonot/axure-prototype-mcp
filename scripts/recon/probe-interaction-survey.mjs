/**
import { BASE } from './_env.mjs';
 * Recon probe 10: how much interaction data does this prototype actually contain?
 *
 * One page with six checkbox toggles is not enough evidence to characterise the feature. This
 * surveys a spread of pages and reports, per page: declared interactions, distinct events, distinct
 * actions, and DOM-inferred candidates. It writes a summary so the changelog can state real numbers
 * instead of a guess.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('recon-out', { recursive: true });

/** A spread across functional areas, taken from the project sitemap. */
const PAGES = [
  ['w2yv7l', '订单管理'],
  ['6k5oyo', '版本更新记录'],
  ['b8yrp4', '工单管理'],
  ['wwb4j6', '流程图'],
];

const browser = await chromium.launch({ headless: true });
const summary = [];

for (const [id, name] of PAGES) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, bypassCSP: true });
  await context.addInitScript(() => {
    const install = () => {
      const ax = window.$axure;
      if (!ax || typeof ax.loadCurrentPage !== 'function' || ax.loadCurrentPage.__hooked) return false;
      const original = ax.loadCurrentPage;
      const wrapped = function () {
        try {
          window.__axureMcpPageModel = arguments[0];
        } catch (error) {
          /* ignore */
        }
        return original.apply(this, arguments);
      };
      wrapped.__hooked = true;
      ax.loadCurrentPage = wrapped;
      return true;
    };
    if (!install()) {
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (install() || tries > 400) clearInterval(timer);
      }, 10);
    }
  });

  const page = await context.newPage();
  let url = `${BASE}/${encodeURIComponent(name)}.html`;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
  } catch (error) {
    // The sitemap's relative URL is the authority; try the id fragment fallback.
    await page.goto(`${BASE}/#id=${id}&p=${encodeURIComponent(name)}`, { waitUntil: 'load', timeout: 45_000 });
  }
  await page.waitForTimeout(4500);

  let frame = null;
  for (const candidate of page.frames()) {
    const n = await candidate.evaluate(() => document.querySelectorAll('#base [id^="u"]').length).catch(() => 0);
    if (n > 0) frame = candidate;
  }

  if (!frame) {
    summary.push({ id, name, error: 'no content frame' });
    await context.close();
    continue;
  }

  const result = await frame.evaluate(() => {
    const model = window.__axureMcpPageModel;
    const domIds = new Set(Array.from(document.querySelectorAll('#base [id^="u"]')).map((el) => el.id));
    if (!model) return { modelCaptured: false, domWidgets: domIds.size };

    const objectPaths = model.objectPaths || {};
    const hashToScript = {};
    for (const [hash, entry] of Object.entries(objectPaths)) {
      if (entry && entry.scriptId) hashToScript[hash] = entry.scriptId;
    }

    const events = {};
    const actions = {};
    const displayNames = {};
    let widgetsWithInteractions = 0;
    let cases = 0;
    const visited = new Set();

    const walk = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 20 || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      if (value.interactionMap && typeof value.interactionMap === 'object') {
        let counted = false;
        for (const [eventName, event] of Object.entries(value.interactionMap)) {
          events[eventName] = (events[eventName] || 0) + 1;
          for (const caseEntry of (event && event.cases) || []) {
            cases += 1;
            for (const act of (caseEntry && caseEntry.actions) || []) {
              if (act && act.action) actions[act.action] = (actions[act.action] || 0) + 1;
              if (act && act.displayName) displayNames[act.displayName] = (displayNames[act.displayName] || 0) + 1;
            }
          }
          counted = true;
        }
        if (counted && hashToScript[value.id]) widgetsWithInteractions += 1;
      }
      for (const key of Object.keys(value)) {
        if (key === 'parent') continue;
        const child = value[key];
        if (child && typeof child === 'object') walk(child, depth + 1);
      }
    };
    walk(model, 0);

    // DOM-inferred candidates, mirroring what the reader reports.
    const domCandidates = { pointer: 0, form: 0, focusable: 0, role: 0 };
    const base = document.getElementById('base');
    for (const el of Array.from((base || document.body).querySelectorAll('[id]'))) {
      if (!/^u\d+$/.test(el.id)) continue;
      try {
        if (getComputedStyle(el).cursor === 'pointer') domCandidates.pointer += 1;
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') domCandidates.form += 1;
        if (el.hasAttribute('tabindex')) domCandidates.focusable += 1;
        if (el.getAttribute('role')) domCandidates.role += 1;
      } catch (error) {
        /* ignore */
      }
    }

    return {
      modelCaptured: true,
      domWidgets: domIds.size,
      idBridge: Object.keys(hashToScript).length,
      widgetsWithInteractions,
      cases,
      events,
      actions,
      displayNames,
      domCandidates,
    };
  });

  summary.push({ id, name, ...result });
  await context.close();
}

console.log(JSON.stringify(summary, null, 1));
writeFileSync('recon-out/interaction-survey.json', JSON.stringify(summary, null, 1));
await browser.close();
