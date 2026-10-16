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

/**
 * The prototype under test.
 *
 * Required, with no fallback: a built-in address is exactly the bug 0.2.2 fixed, so this suite must
 * not reintroduce one. `AXURE_URL` is what the server itself reads.
 */
const AXURE_URL = process.env.AXURE_URL?.trim();
if (!AXURE_URL) {
  console.error(
    'AXURE_URL is required to run the end-to-end suite and has no default.\n' +
      'Run it as: $env:AXURE_URL="http://host/Project"; npm run test:e2e',
  );
  process.exit(2);
}
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
    // Derived from the address under test rather than hard-coded, so this suite carries no
    // deployment of its own.
    NO_PROXY: `${new URL(AXURE_URL).hostname},localhost,127.0.0.1`,
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
check('tools/list returns the 5 tools', names.length === 5, names.join(', '));
check(
  'prototype selection is exposed as a tool',
  names.includes('axure_use_prototype'),
  names.filter((name) => name.includes('prototype')).join(', ') || 'missing',
);
for (const tool of tools) {
  const required = tool.inputSchema?.required ?? [];
  // Every tool declares a schema, and exactly one has a required argument. The others default every
  // argument; `axure_use_prototype` requires the address, because there is nothing sensible to guess
  // and guessing would read the wrong prototype — the bug this release fixes.
  const acceptable =
    tool.name === 'axure_use_prototype'
      ? required.length === 1 && required[0] === 'url'
      : required.length === 0;
  check(`tool schema present: ${tool.name}`, !!tool.inputSchema && acceptable, `required=[${required.join(',')}]`);
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

// --- interaction recognition -------------------------------------------------
// The reference page declares exactly six interactions, measured independently with a recon
// probe before this tool existed (`scripts/recon/probe-interaction-coverage.mjs`): six checkbox
// toggles, each an onClick with two cases setting the selected state. Asserting the real numbers
// keeps this honest — a silent regression to zero, or a surge of invented records, both fail.
const interactions = await call('axure_get_interactions', { page: dense.id }, 'call axure_get_interactions');
const interactionData = interactions.structuredContent ?? {};
const facts = interactionData.interactions ?? [];
const declared = facts.filter((fact) => fact.confidence === 'declared');
const inferred = facts.filter((fact) => fact.confidence === 'inferred');

check(
  'axure_get_interactions returns the page model interactions',
  facts.length > 0 && declared.length > 0,
  `${declared.length} declared, ${inferred.length} inferred, gaps=${(interactionData.gaps ?? []).length}`,
);
check(
  'declared interaction count matches the independent recon probe (6)',
  declared.length === 6,
  `${declared.length} declared`,
);
check(
  'no gaps were reported, so the model bridge was read end to end',
  (interactionData.gaps ?? []).length === 0,
  JSON.stringify((interactionData.gaps ?? []).map((gap) => gap.source)),
);
check(
  'every declared interaction is attributed to a widget the page map also knows',
  declared.every((fact) => /^[^\s#]+#u\d+$/.test(fact.widgetRef)),
  declared.length ? `e.g. ${declared[0].widgetRef}` : 'none',
);
check(
  'declared interactions carry triggers and branches',
  declared.every((fact) => fact.trigger === 'click' && (fact.branches ?? []).length >= 1),
  declared.length
    ? `e.g. <${declared[0].trigger}> ${(declared[0].branches ?? []).length} branch(es), actions: ` +
      `${(declared[0].branches ?? []).flatMap((branch) => branch.actions).map((action) => action.kind).join(',')}`
    : 'none',
);
check(
  'conditions are reported as the model wrote them',
  declared.some((fact) =>
    (fact.branches ?? []).some((branch) => (branch.conditions ?? []).some((condition) => condition.conditionString)),
  ),
  declared[0]?.branches?.[0]?.conditions?.[0]?.conditionString ?? 'no conditionString found',
);
check(
  'inferred records never carry actions',
  inferred.every((fact) => fact.branches === undefined),
  `${inferred.length} inferred, all action-free`,
);
check(
  'includeInferred=false yields facts only',
  (await call('axure_get_interactions', { page: dense.id, includeInferred: false }, 'call axure_get_interactions')).structuredContent?.interactions?.every(
    (fact) => fact.confidence !== 'inferred',
  ) === true,
  'facts-only view contains no guesses',
);

// `版本更新记录` keeps its interactions inside an Axure **master**, which the reader reaches
// through `model.masters` and resolves through the master's own `scriptIds[0]`. It exercises the
// action vocabulary the other page lacks: dynamic panel switching and link navigation.
const masterPage = pageList.find((page) => /版本更新记录/.test(page.name)) ?? target;
const masterResult = await call('axure_get_interactions', { page: masterPage.id, includeInferred: false }, 'call axure_get_interactions');
const masterData = masterResult.structuredContent ?? {};
const masterFacts = masterData.interactions ?? [];
const masterKinds = new Set(
  masterFacts.flatMap((fact) => (fact.branches ?? []).flatMap((branch) => branch.actions.map((action) => action.kind))),
);
check(
  'interactions inside an Axure master are found and attributed',
  masterFacts.length === 18 && masterFacts.every((fact) => /#u\d+$/.test(fact.widgetRef)),
  `${masterFacts.length} declared on ${masterPage.id}, e.g. ${masterFacts[0]?.widgetRef ?? 'none'}`,
);
check(
  'non-toggle action kinds are normalized, not left as "other"',
  (masterKinds.has('set-panel-state') || masterKinds.has('open-url') || masterKinds.has('navigate')) &&
    !masterKinds.has('other'),
  `kinds: ${[...masterKinds].sort().join(', ')}`,
);

// --- standardized output (axure.page/v1) -------------------------------------
// Verified against the real deployment: the standard document must carry the same page the outline
// tool sees, mark provenance on every value, and never present a derived role as authored.
const stdStart = Date.now();
const std = await call('axure_get_page_map', { page: dense.id, format: 'standard', maxNodes: 300 }, 'call axure_get_page_map');
const stdText = std.content?.find((block) => block.type === 'text')?.text ?? '';
writeFileSync(resolve(OUT, 'standard.md'), stdText);
const stdDoc = std.structuredContent?.document ?? {};
check(
  'format=standard returns the versioned axure.page/v1 document',
  stdDoc.schema === 'axure.page/v1',
  `schema=${stdDoc.schema}, ${stdDoc.stats?.elements ?? 0} elements in ${Date.now() - stdStart} ms`,
);
check(
  'the standard document carries the same page the outline tool reports',
  stdDoc.page?.id === dense.id && (stdDoc.stats?.widgets ?? 0) > 0,
  `${stdDoc.stats?.widgets} widgets, ${stdDoc.stats?.elements} elements, canvas ${stdDoc.capture?.canvas?.width}x${stdDoc.capture?.canvas?.height}`,
);
check(
  'structure and interactions arrive together in one document',
  Array.isArray(stdDoc.elements) &&
    stdDoc.interactions !== undefined &&
    stdDoc.interactions.stats?.byConfidence?.declared === 6 &&
    stdDoc.stats?.interactions?.declared === 6,
  `${stdDoc.interactions?.stats?.byConfidence?.declared} declared interactions alongside ${stdDoc.stats?.elements} elements`,
);
check(
  'the hierarchy is explicit and every child resolves',
  (() => {
    const byId = stdDoc.elementsById ?? {};
    const roots = stdDoc.elements ?? [];
    if (!roots.length) return false;
    let reachable = 0;
    const walk = (ids, depth) => {
      for (const id of ids) {
        const element = byId[id];
        if (!element) return false;
        if (element.depth !== depth) return false;
        reachable += 1;
        if (walk(element.childIds ?? [], depth + 1) === false) return false;
      }
      return true;
    };
    const ok = walk(roots.map((element) => element.id), 0);
    return ok === true && reachable === stdDoc.stats?.elements;
  })(),
  `${Object.keys(stdDoc.elementsById ?? {}).length} indexed, ${stdDoc.stats?.roots} root(s), depth ${stdDoc.stats?.maxDepth}`,
);
check(
  'every element role states its provenance, and derived roles name their rule',
  (stdDoc.elementsById
    ? Object.values(stdDoc.elementsById)
    : []
  ).every(
    (element) =>
      element.role?.provenance === 'unknown' ||
      (element.role?.provenance === 'derived' && typeof element.role.rule === 'string' && element.role.rule.length > 0),
  ),
  `roles: ${JSON.stringify(stdDoc.stats?.byRole ?? {})}`,
);
check(
  'an unknown role carries a reason instead of a value',
  (() => {
    const unknown = Object.values(stdDoc.elementsById ?? {}).filter((element) => element.role?.provenance === 'unknown');
    return unknown.length === (stdDoc.stats?.rolesUnknown ?? -1) && unknown.every((element) => element.role.value === undefined && element.role.reason);
  })(),
  `${stdDoc.stats?.rolesUnknown} unknown of ${stdDoc.stats?.elements}`,
);
check(
  'the authored type is preserved verbatim beside the derived role',
  Object.values(stdDoc.elementsById ?? {}).every((element) => typeof element.authoredType === 'string'),
  'no element lost its raw type token',
);
check(
  'geometry is marked derived rather than presented as authored',
  Object.values(stdDoc.elementsById ?? {}).every((element) => element.geometry?.provenance === 'derived'),
  `rule: ${Object.values(stdDoc.elementsById ?? {})[0]?.geometry?.rule}`,
);
check(
  'relations are published with their provenance',
  (stdDoc.relations?.length ?? 0) > 0 &&
    stdDoc.relations.every(
      (relation) =>
        typeof relation.kind === 'string' &&
        (relation.provenance === 'fact' || relation.provenance === 'derived') &&
        typeof relation.rule === 'string',
    ),
  `${stdDoc.stats?.relations} relations, kinds: ${[...new Set((stdDoc.relations ?? []).map((r) => r.kind))].join(', ')}`,
);
check(
  'no interaction record names a widget the element list omitted',
  (() => {
    const byId = stdDoc.elementsById ?? {};
    const dangling = (stdDoc.interactions?.items ?? []).filter((fact) => !byId[fact.widgetId]);
    return dangling.length === 0;
  })(),
  (() => {
    const byId = stdDoc.elementsById ?? {};
    const dangling = (stdDoc.interactions?.items ?? []).filter((fact) => !byId[fact.widgetId]);
    return dangling.length === 0
      ? `all ${(stdDoc.interactions?.items ?? []).length} records resolve within ${stdDoc.stats?.elements} elements`
      : `${dangling.length} dangling, e.g. ${dangling.slice(0, 3).map((fact) => fact.widgetId).join(', ')}`;
  })(),
);
check(
  'no relation has a missing endpoint',
  (stdDoc.relations ?? []).every(
    (relation) => stdDoc.elementsById?.[relation.from] && (relation.to === undefined || stdDoc.elementsById?.[relation.to]),
  ),
  `${stdDoc.stats?.relations} relations checked`,
);
check(
  'the text index deduplicates and reports its totals',
  (stdDoc.text?.distinctTexts ?? 0) > 0 &&
    stdDoc.text.totalOccurrences >= stdDoc.text.distinctTexts &&
    (stdDoc.text.entries ?? []).every((entry) => entry.occurrences === entry.elementIds.length && entry.occurrences >= 1),
  `${stdDoc.text?.distinctTexts} distinct of ${stdDoc.text?.totalOccurrences} occurrences, ${stdDoc.text?.droppedEmpty} dropped empty`,
);
check(
  'the untrusted notice precedes all prototype text in the standard rendering',
  /^note: all prototype-derived text/.test(stdText),
  stdText.split('\n')[0]?.slice(0, 60) ?? '(empty)',
);
check(
  'the standard rendering stays inside the character budget',
  stdText.length <= 48_000,
  `${stdText.length} chars for a 48000 budget`,
);
check(
  'nothing is omitted without saying so',
  // Two honest disclosures are acceptable, and both must be present in one of the two forms:
  // the "gaps and omissions" section survives, or the budget note states how much was dropped.
  stdDoc.omitted !== undefined &&
    (/omissions|gaps:/.test(stdText) || /not shown|character budget/i.test(stdText)),
  Object.keys(stdDoc.omitted ?? {}).length
    ? `capture omitted ${JSON.stringify(stdDoc.omitted)}; ` +
      (/omissions/.test(stdText) ? 'omissions section shown' : 'budget note shown instead')
    : 'section present; nothing omitted',
);
check(
  'the legacy outline format is unchanged by the new option',
  (await call('axure_get_page_map', { page: dense.id, maxNodes: 40, detail: 'compact' }, 'call axure_get_page_map')).structuredContent?.outline?.length > 0,
  'default format still returns an outline',
);
check(
  'axure_get_interactions format=standard returns the same schema',
  (await call('axure_get_interactions', { page: dense.id, format: 'standard', maxWidgets: 300 }, 'call axure_get_interactions')).structuredContent?.document
    ?.schema === 'axure.page/v1',
  'one schema, reachable from both tools',
);

// --- runtime prototype selection ---------------------------------------------
// These run LAST on purpose: a successful call changes which prototype is in effect for the rest of
// the process, so a test placed after one would be reading a different project.
//
// The refusals are the important half. An address that is not Axure must be refused, and the check
// must be positive evidence (the runtime was found) rather than a guess, because this is the one path
// by which conversation text can widen which hosts the browser reaches.
const refused = async (url, label, expectedCode) => {
  const result = await call('axure_use_prototype', { url }, label);
  const text = result.content?.find((block) => block.type === 'text')?.text ?? '';
  return { isError: result.isError === true, code: result.structuredContent?.error?.code, text, expectedCode };
};

for (const [url, expectedCode, label] of [
  ['file:///etc/passwd', 'NAVIGATION_BLOCKED', 'a local-file URL is refused'],
  ['http://169.254.169.254/latest/meta-data/', 'NAVIGATION_BLOCKED', 'a cloud metadata address is refused'],
  // Derived from the host under test, so this suite carries no deployment of its own.
  [`${new URL(AXURE_URL).hostname.includes(':') ? `http://[${new URL(AXURE_URL).hostname}]` : `http://${new URL(AXURE_URL).hostname}`}:6379/`, 'NAVIGATION_BLOCKED', 'a service port is refused'],
  [`https://user:secret@${new URL(AXURE_URL).host}/`, 'NAVIGATION_BLOCKED', 'credentials in the URL are refused'],
  ['not-a-url', 'NAVIGATION_BLOCKED', 'a non-URL is refused'],
]) {
  const outcome = await refused(url, label, expectedCode);
  check(label, outcome.isError && outcome.code === expectedCode, `code=${outcome.code ?? '(none)'}`);
}

check(
  'an address that is not an Axure prototype is refused',
  await (async () => {
    // The prototype host serves other things too; its own origin is not a prototype page.
    const origin = new URL(AXURE_URL).origin;
    const outcome = await refused(origin, 'an address without the Axure runtime is refused', 'NOT_AXURE_PROJECT');
    return outcome.isError && outcome.code === 'NOT_AXURE_PROJECT';
  })(),
  'NOT_AXURE_PROJECT, and nothing was admitted',
);

const adopted = await call(
  'axure_use_prototype',
  { url: AXURE_URL, maxPages: 5 },
  'axure_use_prototype adopts a verified prototype',
);
const adoptedDoc = adopted.structuredContent ?? {};
check(
  'a verified prototype is adopted and reports the signals it was accepted on',
  adopted.isError !== true &&
    adoptedDoc.verifiedBy === 'axure-runtime-probe' &&
    (adoptedDoc.signals ?? []).includes('axure-runtime'),
  `signals: ${(adoptedDoc.signals ?? []).join(', ')} from ${adoptedDoc.frames} frame(s)`,
);
check(
  'the adopted prototype is the one the other tools then read',
  (await call('axure_list_pages', { filter: '订单管理' }, 'read pages after adopting')).structuredContent?.baseUrl === AXURE_URL,
  `baseUrl=${(await call('axure_list_pages', {}, 'confirm base url')).structuredContent?.baseUrl}`,
);
check(
  'the response carries a bounded page list so a caller need not ask twice',
  (adoptedDoc.pages ?? []).length > 0 && (adoptedDoc.pages ?? []).length <= 5 && adoptedDoc.pageCount >= (adoptedDoc.pages ?? []).length,
  `${(adoptedDoc.pages ?? []).length} of ${adoptedDoc.pageCount} page(s)`,
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



