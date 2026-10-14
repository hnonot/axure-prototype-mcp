/**
 * Probe 18: what distinguishes the "expand" and "collapse" cases of the same panel?
 *
 * The tool currently reports `state=1` for both `展开` (expand) and `收起` (collapse) of panel u4,
 * which cannot be right — the two cases must differ somewhere. This dumps every field of both
 * panel-state actions so the reported value can be made accurate rather than plausible.
 */

import { chromium } from 'playwright';

const PAGE = 'https://axure.example.com/ProjectB/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.html';

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
  const rows = [];
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
      for (const [eventName, event] of Object.entries(map)) {
        for (const caseEntry of (event && event.cases) || []) {
          for (const action of (caseEntry && caseEntry.actions) || []) {
            if (!action) continue;
            if (action.action !== 'setPanelState') continue;
            const panel = (action.panelsToStates || [])[0] || {};
            const info = panel.stateInfo || {};
            rows.push({
              widget: String(value.id).slice(0, 8),
              widgetLabel: value.label,
              event: eventName,
              caseDescription: caseEntry.description,
              actionDescription: action.description,
              panelPath: JSON.stringify(panel.panelPath),
              stateNumber: info.stateNumber,
              stateValue: JSON.stringify(info.stateValue),
              setStateType: info.setStateType,
              showWhenSet: info.showWhenSet,
              loop: info.loop,
              allActionKeys: Object.keys(action),
              allStateInfoKeys: Object.keys(info),
            });
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

  // What are the authored state labels of the panels being switched?
  const panelStates = {};
  const collectPanel = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 22) return;
    const id = value.id ? String(value.id) : null;
    if (id && Array.isArray(value.diagrams)) {
      panelStates[id.slice(0, 8)] = {
        label: value.label,
        friendlyType: value.friendlyType,
        states: value.diagrams.length,
        stateLabels: Object.keys(value.interactionMap || {}).length ? 'has-map' : undefined,
      };
    }
    for (const key of Object.keys(value)) {
      if (key === 'parent') continue;
      const child = value[key];
      if (child && typeof child === 'object') collectPanel(child, depth + 1);
    }
  };
  collectPanel(model, 0);

  return { rows, panelStates };
});

console.log('=== setPanelState actions ===');
for (const row of report.rows) {
  console.log(
    `${row.widget} "${row.widgetLabel}" ${row.caseDescription} | desc="${row.actionDescription}" | panel=${row.panelPath} stateNumber=${row.stateNumber} stateValue=${row.stateValue} showWhenSet=${row.showWhenSet}`,
  );
}
console.log('\n=== panels with states ===');
console.log(JSON.stringify(report.panelStates, null, 1).slice(0, 1200));
await browser.close();
