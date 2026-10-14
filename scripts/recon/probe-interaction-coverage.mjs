/**
 * Recon probe 9: verify the id bridge and measure real interaction coverage.
 *
 * Probe 8 found `model.objectPaths[hash].scriptId === 'u<N>'`. This confirms it is complete and
 * bidirectional, and measures how many declared interactions the reference page actually has and
 * what action/event vocabulary they use — the numbers the changelog must report honestly.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const PAGES = process.env.AXURE_PAGE
  ? [process.env.AXURE_PAGE]
  : [
      'https://axure.example.com/ProjectB/%E8%AE%A2%E5%8D%95%E7%AE%A1%E7%90%86.html',
    ];

mkdirSync('recon-out', { recursive: true });
const browser = await chromium.launch({ headless: true });

for (const PAGE of PAGES) {
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
  if (!frame) {
    console.log(PAGE, '-> no content frame');
    await context.close();
    continue;
  }

  const report = await frame.evaluate(() => {
    const model = window.__capturedPageModel;
    if (!model) return { error: 'no captured model' };

    const objectPaths = model.objectPaths || {};
    const hashToScript = {};
    let mapped = 0;
    for (const [hash, entry] of Object.entries(objectPaths)) {
      if (entry && entry.scriptId) {
        hashToScript[hash] = entry.scriptId;
        mapped += 1;
      }
    }

    const domIds = new Set(Array.from(document.querySelectorAll('#base [id^="u"]')).map((el) => el.id));
    let domMatches = 0;
    let domMissing = 0;
    const missingSample = [];
    for (const [hash, scriptId] of Object.entries(hashToScript)) {
      if (domIds.has(scriptId)) domMatches += 1;
      else {
        domMissing += 1;
        if (missingSample.length < 5) missingSample.push({ hash: hash.slice(0, 8), scriptId });
      }
    }

    // Collect all interactions with their resolved DOM ids.
    const interactions = [];
    const events = {};
    const actions = {};
    const displayNames = {};
    const visited = new Set();

    const walk = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 18) return;
      if (visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      if (value.interactionMap && typeof value.interactionMap === 'object') {
        const scriptId = hashToScript[value.id] || null;
        for (const [eventName, event] of Object.entries(value.interactionMap)) {
          events[eventName] = (events[eventName] || 0) + 1;
          const cases = [];
          for (const caseEntry of (event && event.cases) || []) {
            const caseActions = [];
            for (const act of (caseEntry && caseEntry.actions) || []) {
              if (act && act.action) actions[act.action] = (actions[act.action] || 0) + 1;
              if (act && act.displayName) displayNames[act.displayName] = (displayNames[act.displayName] || 0) + 1;
              caseActions.push({
                action: act && act.action,
                displayName: act && act.displayName,
                description: act && act.description,
                targetIds: act && act.targetIds,
                linkType: act && act.linkType,
                pageId: act && act.pageId,
              });
            }
            cases.push({
              description: caseEntry && caseEntry.description,
              conditionString: caseEntry && caseEntry.conditionString,
              actions: caseActions,
            });
          }
          interactions.push({
            hash: value.id,
            scriptId,
            label: value.label,
            friendlyType: value.friendlyType,
            event: eventName,
            eventDescription: event && event.description,
            cases,
          });
        }
      }
      for (const key of Object.keys(value)) {
        if (key === 'parent') continue;
        const child = value[key];
        if (child && typeof child === 'object') walk(child, depth + 1);
      }
    };
    walk(model, 0);

    return {
      widgetCount: Object.keys(hashToScript).length,
      mappedHashes: mapped,
      domMatches,
      domMissing,
      missingSample,
      interactionCount: interactions.length,
      interactions,
      events,
      actions,
      displayNames,
    };
  });

  console.log('===', PAGE.split('/').pop());
  console.log(JSON.stringify(report, null, 1).slice(0, 9000));
  writeFileSync(`recon-out/interaction-coverage-${PAGE.split('/').pop()}.json`, JSON.stringify(report, null, 1));
  await context.close();
}

await browser.close();
