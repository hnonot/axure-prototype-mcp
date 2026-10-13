/**
 * End-to-end self-test.
 *
 * Acts as a real MCP client: it spawns `bin/axure-mcp.mjs` over stdio, performs the
 * protocol handshake, lists the tools, and calls each one against the live Axure
 * deployment. This is the "can it run standalone" verification, independent of DSH.
 *
 * Usage:
 *   node scripts/selftest.mjs
 *   AXURE_URL=http://host/PROJECT node scripts/selftest.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const OUT = resolve(root, 'selftest-out');
mkdirSync(OUT, { recursive: true });

const AXURE_URL = process.env.AXURE_URL || 'https://axure.example.com/ProjectB';
const DEFAULT_PAGE = process.env.SELFTEST_PAGE || '';
const results = [];

const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * Call a tool, converting a thrown client-side error into a check failure.
 *
 * The SDK client throws when `structuredContent` does not satisfy the tool's declared
 * `outputSchema`. That validation is exactly what we want to prove works, so a violation must
 * be reported as a failed check with the schema message instead of aborting the whole run.
 */
const call = async (name, args, label, extra = {}) => {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, false, `threw: ${message.split('\n')[0]}`);
    if (extra.fatal) {
      console.log('\ncannot continue without this call succeeding');
      process.exitCode = 1;
      await client.close().catch(() => undefined);
      process.exit(1);
    }
    return { isError: true, content: [{ type: 'text', text: message }], structuredContent: {} };
  }
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'bin/axure-mcp.mjs')],
  env: {
    ...process.env,
    AXURE_URL,
    NO_PROXY: 'axure.example.com,localhost,127.0.0.1',
    NO_PROXY_ALT: '',
    AXURE_SETTLE_MS: process.env.AXURE_SETTLE_MS || '5000',
    AXURE_SCREENSHOT_DIR: OUT,
  },
  stderr: 'pipe',
});

const client = new Client({ name: 'axure-mcp-selftest', version: '0.1.0' });
transport.stderr?.on('data', (chunk) => {
  const text = String(chunk).trim();
  if (text) console.log(`  [server] ${text}`);
});

console.log(`connecting to axure-prototype-mcp via stdio (AXURE_URL=${AXURE_URL})`);
await client.connect(transport);
check('MCP initialize handshake', true, `server=${client.getServerVersion()?.name}@${client.getServerVersion()?.version}`);

// --- tools/list -------------------------------------------------------------
const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name);
check('tools/list returns the 3 tools', names.length === 3, names.join(', '));
for (const tool of tools) {
  const required = tool.inputSchema?.required ?? [];
  check(`tool schema present: ${tool.name}`, !!tool.inputSchema && required.length === 0, `required=[${required.join(',')}]`);
}

// --- axure_list_pages -------------------------------------------------------
const pagesStart = Date.now();
const pages = await call('axure_list_pages', {}, 'call axure_list_pages', { fatal: true });
const pagesText = pages.content?.find((block) => block.type === 'text')?.text ?? '';
const pageList = pages.structuredContent?.pages ?? [];
check('axure_list_pages returns pages', pageList.length > 0, `${pageList.length} pages in ${Date.now() - pagesStart} ms`);
writeFileSync(resolve(OUT, 'pages.txt'), pagesText);
console.log(pagesText.split('\n').slice(0, 14).join('\n'));

const target = DEFAULT_PAGE
  ? pageList.find((page) => page.id === DEFAULT_PAGE || page.name === DEFAULT_PAGE)
  : pageList.find((page) => /版本更新记录/.test(page.name)) ?? pageList[0];
if (!target) throw new Error('no page available to analyse');
console.log(`\ntarget page: ${target.id} ${target.name} -> ${target.url}`);

// --- axure_get_page_map -----------------------------------------------------
const mapStart = Date.now();
const map = await call('axure_get_page_map', { page: target.id, detail: 'standard', maxNodes: 1500, includeAccessibility: true }, 'call axure_get_page_map');
const mapText = map.content?.find((block) => block.type === 'text')?.text ?? '';
writeFileSync(resolve(OUT, 'page-map.md'), mapText);
const structured = map.structuredContent ?? {};
check(
  'axure_get_page_map returns an outline',
  (structured.stats?.widgets ?? 0) > 0 && (structured.outline?.length ?? 0) > 0,
  `${structured.stats?.widgets} widgets, ${structured.stats?.nodes} nodes in ${Date.now() - mapStart} ms`,
);
check('page map carries geometry', (structured.outline ?? []).every((node) => typeof node.x === 'number' && typeof node.width === 'number'));
check('page map carries text', (structured.stats?.nodes ?? 0) > 0 && mapText.includes('text='), `${mapText.split('\n').length} lines`);
check(
  'page map includes the ARIA snapshot for comparison',
  mapText.includes('dom aria snapshot'),
  'used to evidence that Axure ARIA is contentless',
);

console.log('\n--- page map head ---');
console.log(mapText.split('\n').slice(0, 22).join('\n'));

// pick a few nodes that have text, for the crop test
const flat = [];
const walk = (nodes) => {
  for (const node of nodes ?? []) {
    flat.push(node);
    walk(node.children);
  }
};
walk(structured.outline ?? []);
// Prefer small text-bearing widgets so the crop is a genuinely useful region rather than
// the full-canvas background rectangle, which would make the crop equal the whole canvas.
const textNodes = flat
  .filter(
    (node) =>
      node.text &&
      node.width > 20 &&
      node.height > 10 &&
      node.width <= (structured.pageSize?.width ?? 1920) * 0.75 &&
      node.height <= (structured.pageSize?.height ?? 1080) * 0.75,
  )
  .slice(0, 3);
console.log(`\nwidgets chosen for the crop test: ${textNodes.map((node) => `${node.id}(${node.text.slice(0, 12)})`).join(', ')}`);

// --- axure_get_visual: full page --------------------------------------------
const fullStart = Date.now();
const full = await call('axure_get_visual', { page: target.id, target: 'full-page', savePath: `full-${target.id}.png` }, 'call axure_get_visual');
const fullImage = full.content?.find((block) => block.type === 'image');
const fullSummary = full.structuredContent ?? {};
check(
  'axure_get_visual full-page returns a PNG image block',
  !!fullImage && fullImage.type === 'image' && fullImage.mimeType === 'image/png',
  `${fullImage ? Math.round((fullImage.data.length * 3) / 4 / 1024) : 0} KiB in ${Date.now() - fullStart} ms`,
);
check(
  'full-page capture matches the 1920x1080 canvas 1:1 (no silent scaling)',
  fullSummary.canvas?.width === 1920 && fullSummary.canvas?.height === 1080,
  `canvas=${fullSummary.canvas?.width}x${fullSummary.canvas?.height}`,
);
if (fullImage) writeFileSync(resolve(OUT, `full-${target.id}.png`), Buffer.from(fullImage.data, 'base64'));

// --- axure_get_visual: widget crop ------------------------------------------
if (textNodes.length) {
  const cropStart = Date.now();
  const crop = await call('axure_get_visual', {
      page: target.id,
      target: 'widgets',
      widgetIds: textNodes.map((node) => node.id),
      pad: 12,
      savePath: `crop-${target.id}.png`,
    }, 'call axure_get_visual');
  const cropImage = crop.content?.find((block) => block.type === 'image');
  const cropSummary = crop.structuredContent ?? {};
  check(
    'axure_get_visual widget crop returns a PNG plus geometry',
    !!cropImage && (cropSummary.widgets?.length ?? 0) === textNodes.length,
    `region ${Math.round(cropSummary.region?.width ?? 0)}x${Math.round(cropSummary.region?.height ?? 0)} in ${Date.now() - cropStart} ms`,
  );
  check(
    'widget crop is smaller than the canvas (a real crop)',
    (cropSummary.region?.width ?? 0) < 1920 && (cropSummary.region?.height ?? 0) < 1080,
    `${Math.round(cropSummary.region?.width ?? 0)}x${Math.round(cropSummary.region?.height ?? 0)}`,
  );
  if (cropImage) writeFileSync(resolve(OUT, `crop-${target.id}.png`), Buffer.from(cropImage.data, 'base64'));
}

// --- axure_get_visual: viewport space geometry ------------------------------
const viewportSpace = await call('axure_get_page_map', { page: target.id, space: 'viewport', detail: 'compact', maxNodes: 60 }, 'call axure_get_page_map');
const vs = viewportSpace.structuredContent ?? {};
check(
  'space=viewport returns viewport-relative coordinates and an on-screen flag',
  (vs.outline ?? []).some((node) => node.onScreen === true),
  `${(vs.stats?.offCanvasNodes ?? 0)} off-canvas of ${vs.stats?.nodes} nodes`,
);

// --- error handling ---------------------------------------------------------
const bad = await call('axure_get_visual', { target: 'widgets', widgetIds: ['u999999'] }, 'call axure_get_visual');
const badText = bad.content?.find((block) => block.type === 'text')?.text ?? '';
check('unknown widget id fails with a coded error', bad.isError === true && badText.includes('WIDGET_NOT_FOUND'), badText.split('\n')[1] ?? '');

// --- scoping on a dense page ------------------------------------------------
// A dense MES page is the case that scoping exists for: without it the outline is
// thousands of nodes and a node cap truncates rather than focuses.
const dense = pageList.find((page) => /订单管理/.test(page.name) && !/一期/.test(page.name)) ?? pageList[0];
const scopedStart = Date.now();
const scoped = await call('axure_get_page_map', { page: dense.id, detail: 'compact', region: { x: 500, y: 350, width: 400, height: 40 }, maxNodes: 200 }, 'call axure_get_page_map');
const scopedData = scoped.structuredContent ?? {};
const scopedFlat = [];
const walkScoped = (nodes) => {
  for (const node of nodes ?? []) {
    scopedFlat.push(node);
    walkScoped(node.children);
  }
};
walkScoped(scopedData.outline ?? []);
const outside = scopedFlat.filter((node) => !node.scoped && (node.y >= 390 || node.y + node.height <= 350));
check(
  'region scope returns far fewer nodes than the whole page',
  scopedData.stats?.nodes > 0 && scopedData.stats.nodes < 80 && scopedData.stats.widgets > 300,
  `${scopedData.stats?.nodes} nodes of ${scopedData.stats?.widgets} widgets in ${Date.now() - scopedStart} ms`,
);
check(
  'region scope only keeps nodes that intersect the region',
  outside.length === 0,
  outside.length ? `${outside.length} out-of-region nodes, e.g. ${outside[0].id}@${outside[0].y}` : 'all kept nodes intersect',
);

// --- region semantics follow the requested space -----------------------------
// Regression guard: the region was documented as page coordinates but tested against
// viewport-adjusted node coordinates, so `space="viewport"` silently reinterpreted it.
const viewportRegion = { x: 60, y: 60, width: 320, height: 220 };
const vpScoped = await call('axure_get_page_map', { page: target.id, detail: 'compact', space: 'viewport', region: viewportRegion, maxNodes: 200 }, 'call axure_get_page_map');
const vpData = vpScoped.structuredContent ?? {};
const vpFlat = [];
const walkVp = (nodes) => {
  for (const node of nodes ?? []) {
    vpFlat.push(node);
    walkVp(node.children);
  }
};
walkVp(vpData.outline ?? []);
const vpOutside = vpFlat.filter(
  (node) =>
    !node.scoped &&
    !(
      node.x < viewportRegion.x + viewportRegion.width &&
      node.x + node.width > viewportRegion.x &&
      node.y < viewportRegion.y + viewportRegion.height &&
      node.y + node.height > viewportRegion.y
    ),
);
check(
  'space=viewport interprets region in viewport coordinates',
  vpData.space === 'viewport' && vpFlat.length > 0 && vpOutside.length === 0,
  `${vpFlat.length} nodes, ${vpOutside.length} outside the viewport region` +
    (vpOutside.length ? ` e.g. ${vpOutside[0].id}@${vpOutside[0].x},${vpOutside[0].y}` : ''),
);

// --- untrusted-content notice ------------------------------------------------
const noticeStart = mapText.indexOf('\n');
check(
  'the untrusted-content notice precedes the outline',
  mapText.startsWith('note:') && /untrusted data/.test(mapText.slice(0, 600)),
  JSON.stringify(mapText.slice(0, 60)),
);

// --- response budget ---------------------------------------------------------
// Regression guard: the character budget was only used to derive a per-node text allowance
// with a floor, so a large page could return several times the nominal budget.
const budget = Number.parseInt(process.env.AXURE_OUTLINE_CHAR_BUDGET ?? '48000', 10);
const budgeted = await call('axure_get_page_map', { page: dense.id, detail: 'full', maxNodes: 5000 }, 'call axure_get_page_map');
const budgetedText = budgeted.content?.find((block) => block.type === 'text')?.text ?? '';
check(
  'the response text respects the character budget',
  budgetedText.length <= budget * 1.15,
  `${budgetedText.length} chars for a ${budget} budget (dense page, detail=full, maxNodes=5000)`,
);

// --- degraded path for a text-only consumer ---------------------------------
const noImage = await call('axure_get_visual', { page: target.id, target: 'full-page', includeImage: false }, 'call axure_get_visual');
const noImageImage = noImage.content?.find((block) => block.type === 'image');
const noImageData = noImage.structuredContent ?? {};
check(
  'includeImage=false suppresses the image block but keeps the geometry',
  noImageImage === undefined && noImageData.image?.attached === false && noImageData.canvas?.width > 0,
  `canvas=${noImageData.canvas?.width}x${noImageData.canvas?.height}, ${noImageData.image?.bytes} bytes on disk`,
);

// --- savePath confinement ----------------------------------------------------
const escapedSave = await call('axure_get_visual', { page: target.id, target: 'viewport', savePath: '../../../../evil.png', includeImage: false }, 'call axure_get_visual');
const escapedText = escapedSave.content?.find((block) => block.type === 'text')?.text ?? '';
check(
  'savePath cannot escape the screenshot directory',
  /screenshot written to disk failed/i.test(escapedText) &&
    /savePath must stay inside/i.test(escapedText) &&
    escapedSave.structuredContent?.savedTo === undefined,
  'traversal rejected, reported as a warning, capture still returned',
);

// --- error transparency ------------------------------------------------------
const blocked = await call('axure_get_page_map', { page: 'http://169.254.169.254/' }, 'call axure_get_page_map');
const blockedText = blocked.content?.find((block) => block.type === 'text')?.text ?? '';
check(
  'an out-of-boundary host is refused with a machine-readable code',
  blocked.isError === true && blocked.structuredContent?.error?.code === 'PAGE_NOT_FOUND',
  blockedText.split('\n').find((line) => line.startsWith('error:')) ?? '',
);

await client.close();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`artifacts: ${OUT}`);
if (failed.length) {
  console.log('failed:', failed.map((result) => result.name).join(', '));
  process.exitCode = 1;
}


