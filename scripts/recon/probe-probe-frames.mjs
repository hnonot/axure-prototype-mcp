/**
import { BASE } from './_env.mjs';
 * Run the probe against every frame of the real page.
 *
 * The extraction below matches how the compiled module actually defines the probe (walk to the first
 * *unescaped* backtick) rather than a greedy/non-greedy regex, which is what made an earlier version
 * of this script report a compile error that the real code did not have.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const dist = readFileSync('dist/axure/prototype-url.js', 'utf8');
const marker = 'export const AXURE_URL_PROBE = ';
const bodyStart = dist.indexOf('`', dist.indexOf(marker)) + 1;
let end = -1;
for (let i = bodyStart; i < dist.length; i += 1) {
  if (dist[i] === '`' && dist[i - 1] !== '\\') {
    end = i;
    break;
  }
}
const PROBE = dist.slice(bodyStart, end);
console.log('probe length:', PROBE.length, '| compiles:', (() => {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`${PROBE}; return axureExtractOutline;`)();
    return true;
  } catch (error) {
    return `NO: ${String(error).split('\n')[0]}`;
  }
})());

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'load', timeout: 45_000 });
await page.waitForTimeout(4000);

const frames = page.frames();
console.log('frames:', frames.length);
const results = await Promise.all(
  frames.map((frame) =>
    frame
      .evaluate(`${PROBE}\naxureExtractOutline()`)
      .then((value) => value)
      .catch((error) => ({ error: String(error).split('\n')[0].slice(0, 160) })),
  ),
);
for (const [index, result] of results.entries()) {
  console.log(`  frame ${index}:`, JSON.stringify(result));
}
await browser.close();
