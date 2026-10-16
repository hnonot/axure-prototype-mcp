/**
import { BASE } from './_env.mjs';
 * Recon probe 6: the real widget id ↔ DOM id mapping, and the interaction vocabulary.
 *
 * Findings so far:
 * - the decoded model is at `model.page.diagram.objects`, reached via `$axure.loadCurrentPage`
 * - widgets carry `id` (a 32-char hex hash), `label`, `friendlyType`, `scriptId`, `scriptIds`
 * - `interactionMap[event].cases[].actions[]` holds `action`, `description`, `displayName`, `expr`
 *
 * The outline uses DOM ids of the form `u<number>`, so this probe establishes which model field
 * matches, and enumerates the action/event vocabulary actually present.
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

  const out = { domSample: [], widgetSamples: [], scriptIdMatches: 0, checked: 0 };
  const domIds = new Set(Array.from(document.querySelectorAll('#base [id^="u"]')).map((el) => el.id));
  out.domIdCount = domIds.size;
  out.domSample = Array.from(domIds).slice(0, 12);

  // Which model field matches the DOM ids?
  const matchCounts = { id: 0, scriptId: 0, label: 0, uniqueId: 0, none: 0 };
  const examples = [];

  const visited = new Set();
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 16) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    // Only consider objects that look like widgets.
    if (value.id !== undefined && value.friendlyType !== undefined) {
      out.checked += 1;
      let matched = false;
      for (const field of ['id', 'scriptId', 'label', 'uniqueId']) {
        const candidate = value[field];
        if (candidate !== undefined && domIds.has(String(candidate))) {
          matchCounts[field] += 1;
          if (examples.length < 6) {
            examples.push({
              field,
              value: String(candidate),
              domId: String(candidate),
              label: value.label,
              friendlyType: value.friendlyType,
              hasInteractionMap: value.interactionMap !== undefined,
            });
          }
          matched = true;
        }
      }
      if (!matched) matchCounts.none += 1;
    }
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  };
  walk(model, 0);

  out.matchCounts = matchCounts;
  out.examples = examples;

  // Enumerate the event and action vocabulary actually present, plus the target/link vocabulary.
  const events = {};
  const actions = {};
  const displayNames = {};
  const conditionOps = {};
  const linkFields = {};
  const caseKeys = {};

  const visited2 = new Set();
  const walk2 = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 16) return;
    if (visited2.has(value)) return;
    visited2.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk2(item, depth + 1);
      return;
    }
    const map = value.interactionMap;
    if (map && typeof map === 'object') {
      for (const [eventName, event] of Object.entries(map)) {
        events[eventName] = (events[eventName] || 0) + 1;
        const cases = event && event.cases;
        if (Array.isArray(cases)) {
          for (const caseEntry of cases) {
            for (const key of Object.keys(caseEntry)) caseKeys[key] = (caseKeys[key] || 0) + 1;
            const cond = caseEntry && caseEntry.condition;
            if (cond && typeof cond === 'object') {
              if (cond.op) conditionOps[cond.op] = (conditionOps[cond.op] || 0) + 1;
              if (cond.exprType) conditionOps['exprType:' + cond.exprType] = (conditionOps['exprType:' + cond.exprType] || 0) + 1;
            }
            for (const act of (caseEntry && caseEntry.actions) || []) {
              if (!act || typeof act !== 'object') continue;
              if (act.action) actions[act.action] = (actions[act.action] || 0) + 1;
              if (act.displayName) displayNames[act.displayName] = (displayNames[act.displayName] || 0) + 1;
            }
          }
        }
      }
    }
    // Link vocabulary (page navigation).
    if (value.link && typeof value.link === 'object') {
      for (const key of Object.keys(value.link)) linkFields[key] = (linkFields[key] || 0) + 1;
    }
    for (const key of Object.keys(value)) {
      if (key === 'parent' || key === 'interactionMap') continue;
      const child = value[key];
      if (child && typeof child === 'object') walk2(child, depth + 1);
    }
  };
  walk2(model, 0);

  out.events = events;
  out.actions = actions;
  out.displayNames = displayNames;
  out.conditionOps = conditionOps;
  out.caseKeys = caseKeys;
  out.linkFields = linkFields;
  return out;
});

console.log(JSON.stringify(report, null, 1).slice(0, 9000));
writeFileSync('recon-out/widget-id-mapping.json', JSON.stringify(report, null, 1));
await browser.close();
