/**
 * MCP tool surface for the Axure Prototype server.
 *
 * ## Tool design
 *
 * The server deliberately exposes a *small* surface built around one observation:
 * an agent analysing a prototype page needs structure, space and vision **for the same
 * page at the same moment**. Splitting those into separate `get_structure`,
 * `get_bounding_boxes` and `screenshot` calls would triple the browser work, force the
 * model to re-correlate coordinates across payloads, and make every layout question a
 * multi-call dance.
 *
 * Therefore:
 *
 * - `axure_get_page_map` returns structure **and** space **and** notes in one payload.
 *   Each outline node carries the widget id, kind, authored geometry and its own text,
 *   so a single call answers "what is on this page, and where".
 * - `axure_get_visual` returns the pixels for the same page, either whole-page or for a
 *   named set of widgets, with the geometry of exactly those widgets. That keeps vision
 *   paired with coordinates instead of being a blind image.
 * - `axure_list_pages` is the cheap discovery call so a heavy capture is never spent on
 *   guessing a URL.
 *
 * All three are read-only and idempotent.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { AxureConfig } from './config.js';
import { AxureError, formatError } from './errors.js';
import { BrowserPool, type Logger } from './browser.js';
import { readSitemap, renderSitemap, resolvePageUrl } from './axure-doc.js';
import {
  extractPageView,
  findContentFrame,
  findShellFrame,
  flattenOutline,
  parseWidgetRef,
  renderOutline,
} from './axure-page.js';
import type { OutlineNode, PageViewRequest, PageViewResult, SitemapResult } from './types.js';

/** Tool names, kept in one place for tests and documentation. */
export const TOOL_NAMES = {
  listPages: 'axure_list_pages',
  pageMap: 'axure_get_page_map',
  visual: 'axure_get_visual',
} as const;

/**
 * Default detail level.
 *
 * `standard` adds fill/stroke/radius while staying well inside a Flash-class context
 * window for a 1200-node page, so it is the right default; `compact` exists for very
 * large prototypes and `full` adds typography for design-review questions.
 */
const detailSchema = z.enum(['compact', 'standard', 'full']);
const spaceSchema = z.enum(['page', 'viewport']);
const targetSchema = z.enum(['none', 'viewport', 'full-page', 'widgets']);

const pageSelector = z
  .string()
  .optional()
  .describe(
    'Page to open: an Axure page id from axure_list_pages (e.g. "6k5oyo"), a page name (e.g. "版本更新记录"), ' +
      'a path relative to the project (e.g. "订单管理.html"), or an absolute URL. Omit for the prototype entry page.',
  );

const widgetIdsSchema = z
  .array(z.string())
  .max(40)
  .optional()
  .describe(
    'Widget ids from an earlier axure_get_page_map call (e.g. ["u12"]), or fully qualified refs (e.g. ["6k5oyo#u12"]). ' +
      'When given, the crop and the returned geometry cover exactly these widgets.',
  );

/** Shared plumbing handed to every tool handler. */
export interface ToolContext {
  config: AxureConfig;
  pool: BrowserPool;
  log: Logger;
}

/** Cached sitemap with the time it was read, so repeated calls do not re-navigate. */
interface SitemapCache {
  value: SitemapResult;
  at: number;
}

const SITEMAP_TTL_MS = 5 * 60_000;

/** Register every tool on a server instance. */
export function registerTools(server: McpServer, context: ToolContext): void {
  let sitemapCache: SitemapCache | null = null;

  /** Read the project sitemap, cached for a few minutes because it costs a navigation. */
  const readSitemapCached = async (force = false): Promise<SitemapResult> => {
    if (!force && sitemapCache && Date.now() - sitemapCache.at < SITEMAP_TTL_MS) return sitemapCache.value;
    const session = await context.pool.openSession();
    try {
      const page = session.page;
      await page.goto(context.config.defaultPageUrl, {
        waitUntil: 'load',
        timeout: context.config.navigationTimeoutMs,
      });
      await page.waitForTimeout(context.config.settleMs);
      const frame = await findShellFrame(page);
      const value = await readSitemap(frame, context.config);
      sitemapCache = { value, at: Date.now() };
      return value;
    } finally {
      await session.dispose();
    }
  };

  /** Open a page and return the frame holding its widgets. */
  const openPage = async (selector: string | undefined, viewport?: { width: number; height: number }) => {
    const sitemap = await readSitemapCached().catch(() => undefined);
    const resolved = resolvePageUrl(selector, context.config, sitemap);
    const session = await context.pool.openSession(viewport);
    const page = session.page;
    try {
      const response = await page.goto(resolved.url, {
        waitUntil: 'load',
        timeout: context.config.navigationTimeoutMs,
      });
      await page.waitForTimeout(context.config.settleMs);
      const frame = await findContentFrame(page);
      return { session, frame, resolved, sitemap, httpStatus: response?.status() ?? 0 };
    } catch (error) {
      await session.dispose();
      if (error instanceof AxureError) throw error;
      throw new AxureError(
        'NAVIGATION_FAILED',
        `cannot open ${resolved.url}: ${error instanceof Error ? error.message : String(error)}`,
        'check that the Axure host is reachable from the machine running this server (and that no HTTP proxy intercepts it).',
      );
    }
  };

  /**
   * Grow the viewport until the Axure canvas renders at 1:1.
   *
   * Axure's share player scales the wireframe canvas down to fit the available frame, so
   * a 1920x1080 prototype captured in a 1440x900 viewport produces a 1440x900 image with
   * silently scaled-down text, and clipped widget rectangles no longer line up with the
   * authored coordinates that `axure_get_page_map` reports. Sizing the viewport to the
   * canvas before capturing removes that whole class of mismatch.
   *
   * @returns canvas size and the frame-relative origin of the canvas inside the page.
   */
  const ensureCanvasFits = async (
    page: import('playwright').Page,
    frame: import('playwright').Frame,
    requested?: { width: number; height: number },
  ): Promise<{ canvas: { width: number; height: number }; origin: { x: number; y: number }; resized: boolean }> => {
    const measure = async () =>
      frame
        .evaluate(() => {
          const html = document.documentElement;
          const body = document.body;
          const box = body.getBoundingClientRect();
          return {
            canvasWidth: Math.max(html.scrollWidth, body.scrollWidth, Math.round(box.width)),
            canvasHeight: Math.max(html.scrollHeight, body.scrollHeight, Math.round(box.height)),
            originX: Math.round(box.left),
            originY: Math.round(box.top),
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
          };
        })
        .catch(() => null);

    const before = await measure();
    if (!before) return { canvas: { width: 0, height: 0 }, origin: { x: 0, y: 0 }, resized: false };

    const fits = before.canvasWidth <= before.viewportWidth && before.canvasHeight <= before.viewportHeight;
    if (requested !== undefined || fits) {
      return {
        canvas: { width: before.canvasWidth, height: before.canvasHeight },
        origin: { x: before.originX, y: before.originY },
        resized: false,
      };
    }

    const target = {
      width: Math.min(3_840, Math.max(before.canvasWidth, context.config.viewportWidth)),
      height: Math.min(2_160, Math.max(before.canvasHeight, context.config.viewportHeight)),
    };
    context.log('debug', 'resizing viewport to fit the axure canvas', { from: before.viewportWidth, target });
    await page.setViewportSize(target);
    await page.waitForTimeout(600);
    const after = await measure();
    return {
      canvas: { width: after?.canvasWidth ?? before.canvasWidth, height: after?.canvasHeight ?? before.canvasHeight },
      origin: { x: after?.originX ?? before.originX, y: after?.originY ?? before.originY },
      resized: true,
    };
  };

  // ---------------------------------------------------------------------------
  // axure_list_pages
  // ---------------------------------------------------------------------------
  server.registerTool(
    TOOL_NAMES.listPages,
    {
      title: 'List Axure prototype pages',
      description:
        'List every page of the connected Axure prototype as a folder tree, with each page id and URL. ' +
        'Call this first when you do not yet know which page to analyse: it is one cheap navigation, and the returned ' +
        'page ids can be passed straight to axure_get_page_map or axure_get_visual. Also returns the prototype name and base URL.',
      inputSchema: {
        refresh: z.boolean().optional().describe('Bypass the 5-minute sitemap cache and re-read the project.'),
        filter: z.string().optional().describe('Case-insensitive substring filter applied to page names and paths.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ refresh, filter }) => {
      try {
        const sitemap = await readSitemapCached(refresh === true);
        const filtered = filter
          ? {
              ...sitemap,
              pages: sitemap.pages.filter((page) =>
                `${page.path.join('/')}/${page.name}`.toLowerCase().includes(filter.toLowerCase()),
              ),
            }
          : sitemap;
        const text = [
          renderSitemap(filtered),
          '',
          `tip: pass a page id (left column) as the "page" argument of axure_get_page_map to capture its structure, ` +
            `geometry and annotations in one call, then axure_get_visual for the matching pixels.`,
        ].join('\n');
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: filtered as unknown as Record<string, unknown>,
        };
      } catch (error) {
        context.log('warn', 'list_pages failed', { error: String(error) });
        return { isError: true, content: [{ type: 'text' as const, text: formatError(error) }] };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // axure_get_page_map
  // ---------------------------------------------------------------------------
  server.registerTool(
    TOOL_NAMES.pageMap,
    {
      title: 'Get Axure page structure, geometry and annotations',
      description:
        'Open one Axure prototype page and return its complete structural map in a single call: every widget with its ' +
        'id, kind, authored x/y/width/height, its own text, and (at standard detail) fill, border, corner radius and ' +
        'opacity. Dynamic panels report their state count and active state; widgets that open a link or change state are ' +
        'flagged clickable; images report their asset URL. Page notes/annotations written by the designer are included.\n\n' +
        'Coordinates are absolute page pixels by default; pass space="viewport" for coordinates relative to the visible ' +
        'area plus an on-screen flag, which is what you want when pairing the map with axure_get_visual for the same page. ' +
        'The wireframe canvas is usually 1920x1080, so most outline nodes are off-canvas in the viewport.\n\n' +
        'The format line in the response explains every field. Nodes are capped by maxNodes; when the cap trims the tree ' +
        'the stats line lists the omission reasons. This is a read-only static analysis: it does not click, type or navigate.',
      inputSchema: {
        page: pageSelector,
        space: spaceSchema.optional().describe('Coordinate space: "page" (absolute, default) or "viewport" (relative to the visible area).'),
        detail: detailSchema
          .optional()
          .describe('compact = ids/kinds/geometry/text only; standard (default) adds fill/stroke/radius/opacity; full adds typography and padding.'),
        maxNodes: z
          .number()
          .int()
          .min(20)
          .max(5_000)
          .optional()
          .describe('Maximum outline nodes returned (default 1200). Raise it for very large pages, or lower it to save context.'),
        includeHidden: z
          .boolean()
          .optional()
          .describe('Include widgets whose dynamic-panel state is not active (default false). Useful to enumerate alternate panel states.'),
        includeAccessibility: z
          .boolean()
          .optional()
          .describe(
            'Also append the raw Playwright ARIA snapshot (default false). On Axure pages this is almost always empty of ' +
              'useful roles, so it is off by default; enable it only to prove that claim or to compare against the parsed outline.',
          ),
        includeNotes: z.boolean().optional().describe('Include designer annotations/page notes attached to widgets (default true).'),
        region: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number().positive(),
            height: z.number().positive(),
          })
          .optional()
          .describe(
            'Restrict the outline to one canvas rectangle (page coordinates). Essential for large prototypes: a dense ' +
              'MES page can carry well over a thousand widgets and several thousand pixels of canvas. Nodes that only ' +
              'partly overlap are kept, and ancestors stay in the tree so the shape is preserved.',
          ),
        widgetIds: z
          .array(z.string())
          .max(40)
          .optional()
          .describe(
            'Restrict the outline to these widgets, plus their ancestors and all their descendants. Use it to expand one ' +
              'area of an earlier scoped map, or to pull extra detail for a specific table or panel.',
          ),
        onScreenOnly: z
          .boolean()
          .optional()
          .describe('Drop nodes that do not intersect the current viewport (default false). Useful to see only what a user sees.'),
        viewport: z
          .object({ width: z.number().int().min(320).max(4_000), height: z.number().int().min(240).max(4_000) })
          .optional()
          .describe('Browser viewport to render with (default from AXURE_VIEWPORT_WIDTH/HEIGHT, normally 1440x900).'),
        settleMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe('Extra wait after page load before reading, in milliseconds (default 4000). Raise it for slow prototypes.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const request: PageViewRequest = {
        page: args.page,
        space: args.space ?? 'page',
        detail: args.detail ?? 'standard',
        maxNodes: args.maxNodes ?? context.config.maxOutlineNodes,
        charBudget: context.config.outlineCharBudget,
        includeHidden: args.includeHidden ?? false,
        includeAccessibility: args.includeAccessibility ?? false,
        includeNotes: args.includeNotes ?? true,
        region: args.region,
        widgetIds: args.widgetIds,
        onScreenOnly: args.onScreenOnly,
        settleMs: args.settleMs,
        viewport: args.viewport,
      };
      try {
        const opened = await openPage(request.page, request.viewport);
        try {
          const captured = await extractPageView(opened.session.page, opened.frame, request);
          const tree = request.includeHidden ? captured.outline : pruneHidden(captured.outline);
          const pageId =
            opened.resolved.pageId ??
            opened.sitemap?.pages.find((p) => p.absoluteUrl === opened.resolved.url)?.id ??
            'page';
          for (const node of flattenOutline(tree)) node.ref = `${pageId}#${node.id}`;
          const pageName =
            opened.resolved.pageName ??
            opened.sitemap?.pages.find((p) => p.absoluteUrl === opened.resolved.url)?.name ??
            (await opened.frame.title().catch(() => '')) ??
            pageId;
          const path = opened.sitemap?.pages.find((p) => p.absoluteUrl === opened.resolved.url)?.path ?? [];

          const result: PageViewResult = {
            page: {
              id: pageId,
              name: pageName || pageId,
              url: opened.session.page.url(),
              title: await opened.frame.title().catch(() => ''),
              type: opened.sitemap?.pages.find((p) => p.absoluteUrl === opened.resolved.url)?.type ?? 'Wireframe',
              path,
            },
            space: request.space,
            pageSize: captured.pageSize,
            viewport: captured.viewport,
            detail: request.detail,
            stats: captured.stats,
            outline: tree,
            omitted: captured.omitted,
            scope: captured.scope,
            notes: request.includeNotes ? captured.notes : undefined,
            accessibility: captured.accessibility,
            warnings: captured.warnings,
          };
          result.stats.nodes = flattenOutline(tree).length;

          const text = renderOutline(result);
          return {
            content: [
              { type: 'text' as const, text },
              {
                type: 'text' as const,
                text:
                  `next: call ${TOOL_NAMES.visual} with page="${pageId}" and target="widgets" plus the widget ids you ` +
                  `care about to see those exact regions rendered, or target="full-page" for the whole wireframe.`,
              },
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } finally {
          await opened.session.dispose();
        }
      } catch (error) {
        context.log('warn', 'get_page_map failed', { error: String(error) });
        return { isError: true, content: [{ type: 'text' as const, text: formatError(error) }] };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // axure_get_visual
  // ---------------------------------------------------------------------------
  server.registerTool(
    TOOL_NAMES.visual,
    {
      title: 'Screenshot an Axure page or specific widgets',
      description:
        'Render one Axure prototype page and return PNG pixels plus the geometry of exactly what was captured, so the ' +
        'image is always paired with coordinates you can line up against axure_get_page_map.\n\n' +
        'target="full-page" captures the whole wireframe canvas (ideal for judging layout, spacing and visual hierarchy); ' +
        'target="widgets" crops to the union of the widgets named in widgetIds and reports each one individually ' +
        '(ideal for reading one table, card or dialog closely); target="viewport" captures just the visible area.\n\n' +
        'Set savePath when a downstream programmatic consumer needs the file on disk. Vision models receive the image from ' +
        'the image content block; text-only models receive a size and geometry summary instead of raw pixels.',
      inputSchema: {
        page: pageSelector,
        target: targetSchema.optional().describe('What to capture: "viewport" (default), "full-page", "widgets", or "none" for geometry only.'),
        widgetIds: widgetIdsSchema,
        space: spaceSchema.optional().describe('Coordinate space for the returned geometry: "page" (default) or "viewport".'),
        fullPage: z
          .boolean()
          .optional()
          .describe('Deprecated alias for target="full-page"; kept so earlier callers keep working.'),
        savePath: z
          .string()
          .optional()
          .describe(
            'Write the PNG here as well as returning it. Absolute, or relative to AXURE_SCREENSHOT_DIR ' +
              '(default .axure-mcp/shots under the server working directory).',
          ),
        scale: z
          .number()
          .min(1)
          .max(3)
          .optional()
          .describe(
            'Ignored. Device pixel ratio is fixed when the browser context is created, so it cannot change per call; ' +
              'set AXURE_DEVICE_SCALE_FACTOR=2 and restart the server for high-DPI captures.',
          ),
        pad: z.number().min(0).max(200).optional().describe('Padding in CSS pixels added around a widget crop (default 0).'),
        viewport: z
          .object({ width: z.number().int().min(320).max(4_000), height: z.number().int().min(240).max(4_000) })
          .optional()
          .describe('Browser viewport to render with (default from AXURE_VIEWPORT_WIDTH/HEIGHT, normally 1440x900).'),
        settleMs: z.number().int().min(0).max(30_000).optional().describe('Extra wait after load before capturing (default 4000 ms).'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const target = args.fullPage ? 'full-page' : args.target ?? 'viewport';
      try {
        const opened = await openPage(args.page, args.viewport);
        const page = opened.session.page;
        const frame = opened.frame;
        try {
          const pageId =
            opened.resolved.pageId ??
            opened.sitemap?.pages.find((p) => p.absoluteUrl === opened.resolved.url)?.id ??
            'page';
          const pageName =
            opened.resolved.pageName ??
            opened.sitemap?.pages.find((p) => p.absoluteUrl === opened.resolved.url)?.name ??
            pageId;

          // Render the canvas at 1:1 before measuring anything, so authored widget
          // coordinates and captured pixels share one coordinate system.
          const surfaceInfo = await ensureCanvasFits(page, frame, args.viewport);
          const warnings: string[] = [];

          const scroll = await frame.evaluate(() => ({
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            docWidth: document.documentElement.scrollWidth,
            docHeight: document.documentElement.scrollHeight,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
          }));

          // Region in frame-local (canvas) coordinates.
          const widgetGeometry: Array<Record<string, unknown>> = [];
          const missing: string[] = [];
          let region: { x: number; y: number; width: number; height: number } | undefined;

          if (target === 'widgets') {
            const requested = (args.widgetIds ?? []).map((ref) => parseWidgetRef(ref));
            if (requested.length === 0) {
              throw new AxureError('WIDGET_NOT_FOUND', 'target="widgets" requires at least one id in widgetIds');
            }
            const pad = args.pad ?? 0;
            let minX = Number.POSITIVE_INFINITY;
            let minY = Number.POSITIVE_INFINITY;
            let maxX = Number.NEGATIVE_INFINITY;
            let maxY = Number.NEGATIVE_INFINITY;

            for (const item of requested) {
              const geometry = await frame.evaluate((widgetId) => {
                const ax = (window as unknown as {
                  $axure?: { getRectAndStyleById?: (id: string) => { rect?: Record<string, number> } };
                }).$axure;
                const el = document.getElementById(widgetId);
                if (!el && !ax?.getRectAndStyleById) return null;
                let rect = null;
                try {
                  const authored = ax?.getRectAndStyleById?.(widgetId);
                  rect = authored?.rect ?? null;
                } catch {
                  rect = null;
                }
                if (!rect && el) {
                  const box = el.getBoundingClientRect();
                  rect = {
                    left: box.left + window.scrollX,
                    top: box.top + window.scrollY,
                    width: box.width,
                    height: box.height,
                  };
                }
                return rect
                  ? {
                      left: Number(rect.left),
                      top: Number(rect.top),
                      width: Number(rect.width),
                      height: Number(rect.height),
                    }
                  : null;
              }, item.widgetId);

              if (!geometry) {
                missing.push(item.widgetId);
                continue;
              }
              const useViewport = (args.space ?? 'page') === 'viewport';
              widgetGeometry.push({
                id: item.widgetId,
                ref: `${pageId}#${item.widgetId}`,
                x: round(useViewport ? geometry.left - scroll.scrollX : geometry.left),
                y: round(useViewport ? geometry.top - scroll.scrollY : geometry.top),
                width: round(geometry.width),
                height: round(geometry.height),
              });
              minX = Math.min(minX, geometry.left - pad);
              minY = Math.min(minY, geometry.top - pad);
              maxX = Math.max(maxX, geometry.left + geometry.width + pad);
              maxY = Math.max(maxY, geometry.top + geometry.height + pad);
            }

            if (widgetGeometry.length === 0) {
              throw new AxureError(
                'WIDGET_NOT_FOUND',
                `none of the requested widgets exist on this page: ${missing.join(', ')}`,
                'call axure_get_page_map for this page first and use the ids from its outline.',
              );
            }
            minX = Math.max(0, minX);
            minY = Math.max(0, minY);
            maxX = Math.min(surfaceInfo.canvas.width, maxX);
            maxY = Math.min(surfaceInfo.canvas.height, maxY);
            region = {
              x: minX,
              y: minY,
              width: Math.max(1, maxX - minX),
              height: Math.max(1, maxY - minY),
            };
          }

          const shouldCapture = target !== 'none';
          let png: Buffer | undefined;
          if (shouldCapture) {
            // Playwright's Frame has no screenshot(), so the capture is the page screenshot
            // clipped to the canvas region in page coordinates.
            const originX = surfaceInfo.origin.x;
            const originY = surfaceInfo.origin.y;
            const canvasRegion = {
              x: originX,
              y: originY,
              width: Math.max(1, surfaceInfo.canvas.width),
              height: Math.max(1, surfaceInfo.canvas.height),
            };

            const capture = async (clipRect: { x: number; y: number; width: number; height: number }) =>
              (await page.screenshot({
                type: 'png',
                animations: 'disabled',
                caret: 'hide',
                clip: {
                  x: Math.round(clipRect.x),
                  y: Math.round(clipRect.y),
                  width: Math.round(clipRect.width),
                  height: Math.round(clipRect.height),
                },
              })) as Buffer;

            if (region) {
              const crop = {
                x: originX + region.x - scroll.scrollX,
                y: originY + region.y - scroll.scrollY,
                width: Math.min(region.width, canvasRegion.width),
                height: Math.min(region.height, canvasRegion.height),
              };
              try {
                png = await capture(crop);
              } catch (error) {
                warnings.push(
                  `widget crop failed (${error instanceof Error ? error.message : String(error)}); returned the whole canvas instead`,
                );
                png = await capture(canvasRegion);
              }
            } else if (target === 'full-page') {
              png = await capture(canvasRegion);
            } else {
              png = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
            }
          }

          let savedTo: string | undefined;
          if (png && args.savePath) {
            const destination = isAbsolute(args.savePath)
              ? args.savePath
              : resolve(context.config.screenshotDir, args.savePath);
            await mkdir(resolve(destination, '..'), { recursive: true });
            await writeFile(destination, png);
            savedTo = destination;
          }

          if (surfaceInfo.resized) {
            warnings.push(
              `the browser viewport was enlarged to ${surfaceInfo.canvas.width}x${surfaceInfo.canvas.height} so the ` +
                'prototype canvas renders at 1:1; the previous viewport would have scaled the canvas down.',
            );
          }

          const summary = {
            page: { id: pageId, name: pageName, url: page.url() },
            target,
            space: args.space ?? 'page',
            canvas: surfaceInfo.canvas,
            pageSize: { width: scroll.docWidth, height: scroll.docHeight },
            viewport: {
              width: scroll.viewportWidth,
              height: scroll.viewportHeight,
              scrollX: scroll.scrollX,
              scrollY: scroll.scrollY,
            },
            clip: region ? { x: round(region.x), y: round(region.y), width: round(region.width), height: round(region.height) } : undefined,
            widgets: widgetGeometry,
            missingWidgets: missing.length ? missing : undefined,
            imageBytes: png?.byteLength,
            savedTo,
            warnings: warnings.length ? warnings : undefined,
          };

          const lines: string[] = [];
          lines.push(`# visual: ${pageName} [${pageId}]`);
          lines.push(`target: ${target}  space: ${summary.space}`);
          lines.push(
            `canvas: ${surfaceInfo.canvas.width}x${surfaceInfo.canvas.height}px (1:1)  ` +
              `viewport: ${scroll.viewportWidth}x${scroll.viewportHeight}px  scroll: ${scroll.scrollX},${scroll.scrollY}`,
          );
          if (region) {
            lines.push(
              `region (canvas space): ${round(region.x)},${round(region.y)} ${round(region.width)}x${round(region.height)}`,
            );
          }
          if (widgetGeometry.length) {
            lines.push('widgets:');
            for (const widget of widgetGeometry) {
              lines.push(`  ${widget.id} @${widget.x},${widget.y} ${widget.width}x${widget.height}`);
            }
          }
          for (const warning of warnings) lines.push(`warning: ${warning}`);
          if (missing.length) lines.push(`warning: widgets not found: ${missing.join(', ')}`);
          if (png) {
            lines.push(
              `image: PNG ${Math.round((png.byteLength / 1024) * 10) / 10} KiB attached below for vision-capable models` +
                (savedTo ? `, also written to ${savedTo}` : ''),
            );
          } else {
            lines.push('image: none (target="none" returns geometry only)');
          }

          const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
            { type: 'text', text: lines.join('\n') },
          ];
          if (png) {
            content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
          }
          return { content, structuredContent: summary as unknown as Record<string, unknown> };
        } finally {
          await opened.session.dispose();
        }
      } catch (error) {
        context.log('warn', 'get_visual failed', { error: String(error) });
        return { isError: true, content: [{ type: 'text' as const, text: formatError(error) }] };
      }
    },
  );
}

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Drop nodes whose widget is not currently rendered.
 *
 * The walker already removes zero-area nodes; this removes authored widgets whose
 * dynamic-panel state is inactive, unless the caller explicitly asked for them.
 */
function pruneHidden(nodes: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const node of nodes) {
    if (!node.visible) continue;
    const copy: OutlineNode = { ...node };
    if (node.children) {
      const children = pruneHidden(node.children);
      if (children.length) copy.children = children;
      else delete copy.children;
    }
    out.push(copy);
  }
  return out;
}
