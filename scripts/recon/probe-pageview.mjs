import { loadConfig } from '../../dist/config.js';
import { BrowserPool } from '../../dist/browser.js';
import { findContentFrame, extractPageView } from '../../dist/axure-page.js';

const config = loadConfig();
const pool = new BrowserPool(config, (l, m, meta) => console.log(`[${l}] ${m}`, meta ?? ''));
const session = await pool.openSession();
const page = session.page;
const url = 'https://axure.example.com/ProjectB/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.html';
try {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(config.settleMs);
  const frame = await findContentFrame(page);
  console.log('frame', frame.name() || '(main)', frame.url().slice(0, 100));
  const captured = await extractPageView(page, frame, {
    space: 'page',
    detail: 'standard',
    maxNodes: 1500,
    charBudget: 48000,
    includeHidden: false,
    includeAccessibility: false,
    includeNotes: true,
  });
  console.log('OK widgets=', captured.stats.widgets, 'nodes=', captured.stats.nodes, 'top=', captured.outline.length);
  console.log('sample:', JSON.stringify(captured.outline[0], null, 1).slice(0, 900));
  console.log('notes:', JSON.stringify(captured.notes).slice(0, 300));
} catch (e) {
  console.log('ERR', e && e.stack ? e.stack.split('\n').slice(0, 12).join('\n') : String(e));
}
await session.dispose();
await pool.dispose();

