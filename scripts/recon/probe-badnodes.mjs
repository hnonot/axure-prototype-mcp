import { chromium } from 'playwright';
import { DEFAULT_PAGE } from './_env.mjs';
import { readFileSync } from 'node:fs';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
const page = await ctx.newPage();
await page.goto(DEFAULT_PAGE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);

const src = readFileSync('../../src/axure-page.ts', 'utf8');
const match = /EXTRACT_SOURCE = String\.raw`([\s\S]*?)`;\n/.exec(src);
if (!match) throw new Error('could not extract EXTRACT_SOURCE');
const body = match[1];
console.log('extracted source length', body.length);

const result = await page.mainFrame().evaluate((code) => {
  const factory = new Function(`${code}; return axureExtractOutline;`)();
  const out = factory({ includeNotes: true });
  const bad = [];
  const walk = (nodes, path) => {
    for (const n of nodes ?? []) {
      if (!n || !n.rect) { bad.push({ path, node: JSON.stringify(n).slice(0, 300) }); continue; }
      if (typeof n.rect.width !== 'number') bad.push({ path, rect: JSON.stringify(n.rect) });
      walk(n.children, `${path}/${n.id}`);
    }
  };
  walk(out.nodes, '');
  return { widgets: out.totalWidgets, top: out.nodes.length, bad: bad.slice(0, 8), badCount: bad.length };
}, body);
console.log(JSON.stringify(result, null, 1));
await browser.close();


