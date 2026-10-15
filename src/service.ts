/**
 * Application service: the orchestration layer.
 *
 * This is where a tool call becomes a sequence of browser operations. It is deliberately
 * free of any MCP, client or model concept — it knows about Axure pages, sessions and
 * screenshots, and it returns plain data. The MCP layer above it only validates arguments
 * and formats results; the adapter below it only drives Chromium.
 *
 * Policies owned here:
 *
 * - the sitemap is cached, because reading it costs a full navigation;
 * - a page is captured in an isolated session that is always closed;
 * - the capture viewport is grown to the canvas size so pixels and authored coordinates
 *   share one coordinate system (Axure otherwise scales the canvas down silently);
 * - a caller-supplied `savePath` is confined to the screenshot directory.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AxureConfig } from './config.js';
import { AxureMcpError, DomainError, InfrastructureError, messageOf } from './errors.js';
import type { Logger } from './logger.js';
import { neutralizeUntrusted, resolveWithinBase, truncateWellFormed } from './security.js';
import type { FrameHandle, PlaywrightAdapter, SessionHandle } from './playwright/adapter.js';
import { capturePageMap, flattenOutline, parseWidgetRef, type CaptureOutcome } from './axure/page-map.js';
import { readSitemap, resolvePage, type ResolvedPage } from './axure/sitemap.js';
import { INTERACTION_SOURCE, type RawInteractionCapture } from './axure/interaction-runtime.js';
import { analyzeInteractions } from './axure/interaction-analyzer.js';
import { summarize } from './axure/interaction.js';
import { standardize } from './axure/standard.js';
import type {
  InteractionAnalysis,
} from './axure/interaction-analyzer.js';
import type {
  InteractionFact,
  InteractionRequest,
  InteractionResult,
  PageMapRequest,
  PageMapResult,
  PageOutput,
  SitemapResult,
  StandardDocument,
  VisualRequest,
  VisualResult,
  WidgetGeometry,
} from './types.js';

const SITEMAP_TTL_MS = 5 * 60_000;

/**
 * Largest PNG the server will attach as an image block.
 *
 * Base64 inflates by roughly a third, and the value is carried inside the JSON-RPC frame, so
 * an unbounded attach could push tens of megabytes into one response. A full-canvas capture is
 * typically well under 1 MiB; a capture this large is a signal to crop instead.
 */
const MAX_ATTACHABLE_IMAGE_BYTES = 8 * 1024 * 1024;

/** A short id used to correlate the log lines of one tool call. */
function requestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Canvas size and where it starts inside the top-level page. */
interface SurfaceInfo {
  canvas: { width: number; height: number };
  origin: { x: number; y: number };
  resized: boolean;
}

export class AxureService {
  readonly #config: AxureConfig;
  readonly #adapter: PlaywrightAdapter;
  readonly #log: Logger;
  #sitemapCache: { value: SitemapResult; at: number } | null = null;

  constructor(config: AxureConfig, adapter: PlaywrightAdapter, log: Logger) {
    this.#config = config;
    this.#adapter = adapter;
    this.#log = log;
  }

  /** The boundary used for navigation and page-reference resolution. */
  #boundary() {
    return {
      baseUrl: this.#config.baseUrl,
      allowedHosts: this.#config.allowedHosts,
      defaultPageUrl: this.#config.defaultPageUrl,
    };
  }

  /** Read the project sitemap, cached for a few minutes. */
  async listPages(options: { refresh?: boolean; filter?: string }): Promise<{
    sitemap: SitemapResult;
    filter?: string;
    truncated: boolean;
  }> {
    const id = requestId();
    const log = this.#log.child({ requestId: id, tool: 'list_pages' });
    log.debug('reading sitemap', { refresh: options.refresh === true });

    const cached = this.#sitemapCache;
    let sitemap: SitemapResult;
    if (!options.refresh && cached && Date.now() - cached.at < SITEMAP_TTL_MS) {
      sitemap = cached.value;
    } else {
      const session = await this.#adapter.openSession();
      try {
        await this.#navigateOrThrow(session, this.#config.defaultPageUrl);
        await session.wait(this.#config.settleMs);
        const shell = await this.#frameOrThrow(session, 'shell');
        sitemap = await readSitemap(shell, this.#config.baseUrl);
        this.#sitemapCache = { value: sitemap, at: Date.now() };
        log.debug('sitemap cached', { pages: sitemap.pageCount });
      } finally {
        await session.close();
      }
    }

    const filter = options.filter?.trim();
    let pages = sitemap.pages;
    if (filter) {
      const needle = filter.toLowerCase();
      // The filter is bounded at the schema, and matching is bounded here.
      pages = pages.filter((page) => `${page.path.join('/')}/${page.name}`.toLowerCase().includes(needle));
    }
    const truncated = pages.length > this.#config.maxPages;
    const limited = truncated ? pages.slice(0, this.#config.maxPages) : pages;

    const folders = new Set(limited.flatMap((page) => page.path.map((_segment, index) => page.path.slice(0, index + 1).join('/'))));
    return {
      sitemap: {
        ...sitemap,
        pages: limited,
        pageCount: limited.length,
        folderCount: folders.size,
      },
      filter,
      truncated,
    };
  }

  /**
   * Navigate, converting any browser failure into a stable code.
   *
   * Without this, a failure inside the sitemap read escaped as `INTERNAL` while the identical
   * failure in the page tools reported `NAVIGATION_FAILED`.
   */
  async #navigateOrThrow(session: SessionHandle, url: string): Promise<void> {
    try {
      await session.navigate(url);
    } catch (error) {
      if (error instanceof AxureMcpError) throw error;
      throw new InfrastructureError('NAVIGATION_FAILED', `cannot open ${url}: ${messageOf(error)}`, {
        retryable: true,
        hint: 'Check that the Axure host is reachable from this machine and that no HTTP proxy intercepts it.',
        cause: error,
      });
    }
  }

  /**
   * Resolve a frame, keeping the specific frame error code.
   *
   * The previous implementation wrapped the whole open sequence in one catch, so a page that
   * loaded fine but had no Axure content frame was reported as "cannot open <url>" with a
   * navigation code.
   */
  async #frameOrThrow(session: SessionHandle, kind: 'content' | 'shell'): Promise<FrameHandle> {
    try {
      return kind === 'content' ? await session.contentFrame() : await session.shellFrame();
    } catch (error) {
      if (error instanceof AxureMcpError) throw error;
      throw new InfrastructureError(
        kind === 'content' ? 'NO_CONTENT_FRAME' : 'NOT_AXURE_PROJECT',
        kind === 'content'
          ? 'the page loaded but contains no Axure widget frame'
          : 'the page loaded but exposes no Axure project document',
        {
          hint:
            kind === 'content'
              ? 'The URL must be an Axure page of this project; a project folder or a non-prototype page has no widget frame.'
              : 'Point AXURE_URL at the project root share link, for example http://host/PROJECTID.',
          cause: error,
        },
      );
    }
  }

  /** Resolve a caller page reference, consulting the sitemap for ids and names. */
  async #resolve(selector: string | undefined, log: Logger): Promise<ResolvedPage> {
    let sitemap: SitemapResult | undefined;
    if (selector) {
      try {
        sitemap = (await this.listPages({})).sitemap;
      } catch (error) {
        // A missing sitemap only costs the ability to resolve by id or name; an explicit
        // page id or URL still works, so this must not fail the whole call.
        log.debug('sitemap unavailable while resolving a page', { error: messageOf(error) });
      }
    }
    return resolvePage(selector, this.#boundary(), sitemap);
  }

  /** Open a page and return the session plus its resolved identity. */
  async #openPage(
    selector: string | undefined,
    log: Logger,
    viewport?: { width: number; height: number },
  ): Promise<{ session: SessionHandle; content: FrameHandle; page: ResolvedPage }> {
    const page = await this.#resolve(selector, log);
    const session = await this.#adapter.openSession();
    try {
      if (viewport) await session.setViewportSize(viewport);
      await this.#navigateOrThrow(session, page.url);
      log.debug('navigated', { url: page.url });
      await session.wait(this.#config.settleMs);
      const content = await this.#frameOrThrow(session, 'content');
      return { session, content, page };
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  /** A stable page id, falling back to the URL when the page is not in the sitemap. */
  #pageId(page: ResolvedPage): string {
    return page.pageId ?? neutralizeUntrusted(page.url);
  }

  /**
   * Grow the viewport until the Axure canvas renders at 1:1.
   *
   * Axure's share player scales the wireframe canvas down to fit the available frame, so a
   * 1920x1080 prototype captured in a 1440x900 viewport produces a 1440x900 image with
   * silently scaled-down text, and clipped widget rectangles no longer line up with the
   * authored coordinates the page map reports. Sizing the viewport to the canvas first
   * removes that whole class of mismatch.
   */
  async #ensureCanvasFits(
    session: SessionHandle,
    frame: FrameHandle,
    explicitViewport: boolean,
    log: Logger,
  ): Promise<SurfaceInfo> {
    const measure = async (): Promise<SurfaceInfo | null> => {
      const box = await frame.bodyBox();
      if (!box) return null;
      const canvas = await frame.run<{ width: number; height: number }>(`function axureExtractOutline() {
        const html = document.documentElement;
        const body = document.body;
        const rect = body.getBoundingClientRect();
        return {
          width: Math.max(html.scrollWidth, body.scrollWidth, Math.round(rect.width)),
          height: Math.max(html.scrollHeight, body.scrollHeight, Math.round(rect.height)),
        };
      }`);
      if (typeof canvas?.width !== 'number' || typeof canvas?.height !== 'number') return null;
      return { canvas, origin: { x: Math.round(box.x), y: Math.round(box.y) }, resized: false };
    };

    const before = await measure();
    if (!before) return { canvas: { width: 0, height: 0 }, origin: { x: 0, y: 0 }, resized: false };
    if (explicitViewport) return before;

    const viewport = await frame.run<{ width: number; height: number }>(`function axureExtractOutline() {
      return { width: window.innerWidth, height: window.innerHeight };
    }`);
    const fits =
      before.canvas.width <= (viewport?.width ?? 0) && before.canvas.height <= (viewport?.height ?? 0);
    if (fits) return before;

    const target = {
      width: Math.min(
        this.#config.maxCaptureViewportWidth,
        Math.max(before.canvas.width, this.#config.viewportWidth),
      ),
      height: Math.min(
        this.#config.maxCaptureViewportHeight,
        Math.max(before.canvas.height, this.#config.viewportHeight),
      ),
    };
    log.debug('resizing viewport to fit the axure canvas', { target });
    await session.setViewportSize(target);
    await session.wait(600);
    const after = await measure();
    return after ? { ...after, resized: true } : { ...before, resized: true };
  }

  /** Capture one page's structure, geometry and annotations. */
  async getPageMap(request: PageMapRequest): Promise<PageOutput> {
    const id = requestId();
    const log = this.#log.child({ requestId: id, tool: 'get_page_map', page: request.page });
    log.debug('capturing page map');
    const started = Date.now();

    const opened = await this.#openPage(request.page, log, request.viewport);
    try {
      const pageId = this.#pageId(opened.page);

      // `region` is documented as being in the same space the caller asked coordinates to be
      // reported in. Scoping happens after normalization, where node coordinates are already
      // space-adjusted, so a viewport-space region has to be converted to canvas space first
      // — otherwise a viewport region would silently be interpreted as page coordinates.
      const effective: PageMapRequest = { ...request };
      if (request.region && request.space === 'viewport') {
        const scroll = await opened.content.run<{ scrollX: number; scrollY: number }>(`function axureExtractOutline() {
          return { scrollX: window.scrollX, scrollY: window.scrollY };
        }`);
        effective.region = {
          x: request.region.x + (scroll?.scrollX ?? 0),
          y: request.region.y + (scroll?.scrollY ?? 0),
          width: request.region.width,
          height: request.region.height,
        };
      }

      const captured = await capturePageMap(opened.content, effective, pageId);

      // Hidden widgets are dropped unless the caller asked for them.
      const outline = request.includeHidden ? captured.outline : pruneHidden(captured.outline);
      for (const node of flattenOutline(outline)) node.ref = `${pageId}#${node.id}`;

      const title = neutralizeUntrusted(await opened.content.title());
      const result: PageMapResult = {
        page: {
          id: pageId,
          name: opened.page.pageName ?? (title || pageId),
          url: neutralizeUntrusted(opened.session.url()),
          title,
          type: opened.page.type ?? 'Wireframe',
          path: opened.page.path,
        },
        space: request.space,
        pageSize: captured.pageSize,
        viewport: captured.viewport,
        detail: request.detail,
        stats: captured.stats,
        outline,
        omitted: captured.omitted,
        // The echoed scope describes the caller's own space, not the internal conversion.
        scope: captured.scope ? { ...captured.scope, region: request.region } : undefined,
        notes: request.includeNotes ? captured.notes : undefined,
        accessibility: truncateWellFormed(captured.accessibility ?? '', this.#accessibilityBudget()),
        warnings: captured.warnings,
      };
      if (!result.accessibility) delete result.accessibility;
      result.stats.nodes = flattenOutline(outline).length;
      log.debug('page map captured', { widgets: result.stats.widgets, nodes: result.stats.nodes, ms: Date.now() - started });

      // The standard document is built from the values already captured above plus one extra pass
      // for interactions, so asking for both shapes costs one page load rather than two.
      if (request.format === 'standard') {
        const analysis = await this.#readInteractions(opened.content, pageId, result.stats.widgets);

        // An interaction record that names a widget the element list dropped is a dangling
        // reference: a reader cannot tell what the interaction is *on*. So the widgets the records
        // actually refer to are protected from the node budget. Re-capture only when the budget
        // really did drop one, which leaves the common case at a single capture.
        const referenced = collectInteractionWidgetIds(analysis.interactions);
        const present = new Set(flattenOutline(outline).map((node) => node.id));
        let finalOutline = outline;
        let finalCaptured = captured;
        const missing = [...referenced].filter((widgetId) => !present.has(widgetId));
        if (missing.length > 0) {
          finalCaptured = await capturePageMap(opened.content, effective, pageId, new Set(missing));
          finalOutline = request.includeHidden ? finalCaptured.outline : pruneHidden(finalCaptured.outline);
          for (const node of flattenOutline(finalOutline)) node.ref = `${pageId}#${node.id}`;
          log.debug('re-captured to keep interaction targets', { recovered: missing.length });
        }

        const document = standardize({
          page: {
            id: result.page.id,
            name: result.page.name,
            url: result.page.url,
            title: result.page.title,
            type: result.page.type,
            path: result.page.path,
          },
          capture: finalCaptured,
          outline: finalOutline,
          interactions: analysis,
          space: request.space,
          detail: request.detail,
          scope: finalCaptured.scope,
          // Passed in rather than read from the clock, so `standardize` stays pure and testable.
          at: new Date().toISOString(),
          notes: request.includeNotes ? result.notes : undefined,
          widgetCount: result.stats.widgets,
          pageStats: finalCaptured.stats,
        });
        log.debug('standard document built', {
          elements: document.stats.elements,
          relations: document.stats.relations,
          rolesUnknown: document.stats.rolesUnknown,
          interactionTargetsRecovered: missing.length,
          ms: Date.now() - started,
        });
        return { format: 'standard', result: document };
      }

      return { format: 'outline', result };
    } finally {
      await opened.session.close();
    }
  }

  /**
   * Read and analyze the page's interactions on an already-open frame.
   *
   * Shared by the interaction tool and the standard document so the two cannot drift: both get
   * their widget counts from the same outline extractor and their evidence levels from the same
   * analyzer.
   */
  async #readInteractions(
    frame: import('./playwright/adapter.js').FrameHandle,
    pageId: string,
    widgetCount: number,
  ): Promise<InteractionAnalysis> {
    const presentWidgets = new Set<string>();
    try {
      const outline = await capturePageMap(
        frame,
        {
          space: 'page',
          detail: 'compact',
          maxNodes: this.#config.maxOutlineNodes,
          charBudget: this.#config.outlineCharBudget,
          includeHidden: true,
          includeAccessibility: false,
          includeNotes: false,
        },
        pageId,
      );
      for (const node of flattenOutline(outline.outline)) presentWidgets.add(node.id);
    } catch (error) {
      // The outline is only needed to resolve targets; losing it degrades target resolution rather
      // than the whole call, so it is reported as a warning and not rethrown.
      this.#log.warn('outline unavailable while reading interactions', { message: messageOf(error) });
    }

    let capture: RawInteractionCapture;
    try {
      capture = await frame.run<RawInteractionCapture>(INTERACTION_SOURCE, {
        maxWidgets: this.#config.maxInteractionWidgets,
      });
    } catch (error) {
      throw new InfrastructureError('RENDER_FAILED', `interaction extraction failed: ${messageOf(error)}`, {
        retryable: true,
        hint: 'The content frame may have navigated or the prototype may have re-rendered mid-capture; retry the call.',
        cause: error,
      });
    }
    if (!capture?.ok) {
      throw new InfrastructureError('RENDER_FAILED', 'the in-page interaction reader did not report success');
    }

    return analyzeInteractions(
      capture,
      pageId,
      widgetCount,
      presentWidgets.size ? (widgetId: string) => presentWidgets.has(widgetId) : undefined,
    );
  }

  /**
   * The ARIA snapshot is an unbounded dump of page text, so it gets its own slice of the
   * response budget rather than being able to dominate a small context window.
   */
  #accessibilityBudget(): number {
    return Math.max(1_000, Math.min(16_000, Math.floor(this.#config.outlineCharBudget / 3)));
  }

  /**
   * Analyse one page's interactions.
   *
   * The evidence level of every record is decided here, from the source it came from — never
   * from how plausible the data looks. The project model produces `declared` facts; DOM
   * appearance produces `inferred` guesses; and a source that could not be read produces a
   * stated gap rather than an empty list that would read as "this page has no interactions".
   */
  async getInteractions(request: InteractionRequest): Promise<InteractionResult | StandardDocument> {
    const id = requestId();
    const log = this.#log.child({ requestId: id, tool: 'get_interactions', page: request.page });
    log.debug('analysing interactions');
    const started = Date.now();

    const opened = await this.#openPage(request.page, log, request.viewport);
    try {
      const frame = opened.content;
      const pageId = this.#pageId(opened.page);
      const warnings: string[] = [];

      // Widget count and presence come from the outline extractor, so the interaction result and
      // the page map agree about what is on the page. The outline is kept for the standard format,
      // which needs the elements themselves and not only the interaction records.
      let widgetCount = 0;
      const presentWidgets = new Set<string>();
      let outlineCapture: CaptureOutcome | undefined;
      try {
        outlineCapture = await capturePageMap(
          frame,
          {
            space: 'page',
            detail: 'compact',
            maxNodes: this.#config.maxOutlineNodes,
            charBudget: this.#config.outlineCharBudget,
            includeHidden: true,
            includeAccessibility: false,
            includeNotes: false,
          },
          pageId,
        );
        widgetCount = outlineCapture.stats.widgets;
        for (const node of flattenOutline(outlineCapture.outline)) presentWidgets.add(node.id);
      } catch (error) {
        warnings.push(
          `the page outline could not be read, so widget counts and target resolution are unavailable: ${messageOf(error)}`,
        );
      }

      let capture: RawInteractionCapture;
      try {
        capture = await frame.run<RawInteractionCapture>(INTERACTION_SOURCE, {
          maxWidgets: request.maxWidgets,
        });
      } catch (error) {
        throw new InfrastructureError('RENDER_FAILED', `interaction extraction failed: ${messageOf(error)}`, {
          retryable: true,
          hint: 'The content frame may have navigated or the prototype may have re-rendered mid-capture; retry the call.',
          cause: error,
        });
      }

      if (!capture?.ok) {
        throw new InfrastructureError('RENDER_FAILED', 'the in-page interaction reader did not report success');
      }

      const analysis = analyzeInteractions(
        capture,
        pageId,
        widgetCount,
        presentWidgets.size ? (widgetId: string) => presentWidgets.has(widgetId) : undefined,
      );

      const title = neutralizeUntrusted(await frame.title());
      const interactions = request.includeInferred
        ? analysis.interactions
        : analysis.interactions.filter((fact) => fact.confidence !== 'inferred');

      // The statistics must describe what is actually being returned, so they are recomputed
      // after filtering rather than carried over from the unfiltered analysis.
      const stats = summarize(interactions, widgetCount);

      const result: InteractionResult = {
        page: {
          id: pageId,
          name: opened.page.pageName ?? (title || pageId),
          url: neutralizeUntrusted(opened.session.url()),
          title,
          type: opened.page.type ?? 'Wireframe',
          path: opened.page.path,
        },
        interactions,
        stats,
        gaps: analysis.gaps,
        warnings: [...warnings, ...analysis.warnings],
      };

      log.debug('interactions analysed', {
        widgets: widgetCount,
        declared: stats.byConfidence.declared,
        inferred: stats.byConfidence.inferred,
        gaps: result.gaps.length,
        ms: Date.now() - started,
      });

      // The same unified document `axure_get_page_map` builds with format="standard", so a caller
      // that wants the interaction section *with* its surroundings gets the identical shape from
      // either tool. The page outline was already captured above, so this costs no extra load.
      if (request.format === 'standard' && outlineCapture) {
        return standardize({
          page: result.page,
          capture: outlineCapture,
          outline: outlineCapture.outline,
          interactions: { ...analysis, interactions },
          space: 'page',
          detail: 'compact',
          scope: outlineCapture.scope,
          at: new Date().toISOString(),
          widgetCount,
          pageStats: outlineCapture.stats,
        });
      }

      return result;
    } finally {
      await opened.session.close();
    }
  }

  /** Capture pixels for one page, region or widget set. */
  async getVisual(request: VisualRequest): Promise<VisualResult> {
    const id = requestId();
    const log = this.#log.child({ requestId: id, tool: 'get_visual', page: request.page });
    log.debug('capturing visual', { target: request.target });
    const started = Date.now();

    const opened = await this.#openPage(request.page, log, request.viewport);
    try {
      const frame = opened.content;
      const surface = await this.#ensureCanvasFits(opened.session, frame, request.viewport !== undefined, log);
      const warnings: string[] = [];
      const pageId = this.#pageId(opened.page);
      const title = neutralizeUntrusted(await frame.title());

      const scroll = await frame.run<{
        scrollX: number;
        scrollY: number;
        viewportWidth: number;
        viewportHeight: number;
      }>(`function axureExtractOutline() {
        return {
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        };
      }`);
      const scrollX = scroll?.scrollX ?? 0;
      const scrollY = scroll?.scrollY ?? 0;

      const widgets: WidgetGeometry[] = [];
      const missing: string[] = [];
      let region: VisualResult['region'];

      if (request.target === 'widgets') {
        const requested = (request.widgetIds ?? []).map((ref) => parseWidgetRef(ref).widgetId);
        if (requested.length === 0) {
          throw new DomainError('INVALID_ARGUMENT', 'target="widgets" requires at least one id in widgetIds');
        }
        const pad = request.pad;
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        for (const widgetId of requested) {
          const geometry = await frame.run<{ left: number; top: number; width: number; height: number } | null>(
            `function axureExtractOutline(value) {
              const widgetId = value.widgetId;
              const ax = window.$axure;
              const el = document.getElementById(widgetId);
              if (!el && !(ax && typeof ax.getRectAndStyleById === 'function')) return null;
              let rect = null;
              try {
                const authored = ax && typeof ax.getRectAndStyleById === 'function' ? ax.getRectAndStyleById(widgetId) : null;
                rect = authored && authored.rect ? authored.rect : null;
              } catch (error) { rect = null; }
              if (!rect && el) {
                const box = el.getBoundingClientRect();
                rect = { left: box.left + window.scrollX, top: box.top + window.scrollY, width: box.width, height: box.height };
              }
              if (!rect) return null;
              return { left: Number(rect.left), top: Number(rect.top), width: Number(rect.width), height: Number(rect.height) };
            }`,
            { widgetId },
          );

          if (!geometry) {
            missing.push(widgetId);
            continue;
          }
          const useViewport = request.space === 'viewport';
          widgets.push({
            id: widgetId,
            ref: `${pageId}#${widgetId}`,
            x: useViewport ? geometry.left - scrollX : geometry.left,
            y: useViewport ? geometry.top - scrollY : geometry.top,
            width: geometry.width,
            height: geometry.height,
          });
          minX = Math.min(minX, geometry.left - pad);
          minY = Math.min(minY, geometry.top - pad);
          maxX = Math.max(maxX, geometry.left + geometry.width + pad);
          maxY = Math.max(maxY, geometry.top + geometry.height + pad);
        }

        if (widgets.length === 0) {
          throw new DomainError('WIDGET_NOT_FOUND', `none of the requested widgets exist on this page: ${missing.join(', ')}`, {
            hint: 'Call axure_get_page_map for this page first and use the ids from its outline.',
          });
        }
        region = {
          x: Math.max(0, minX),
          y: Math.max(0, minY),
          width: Math.max(1, Math.min(surface.canvas.width, maxX) - Math.max(0, minX)),
          height: Math.max(1, Math.min(surface.canvas.height, maxY) - Math.max(0, minY)),
        };
      }

      let image: VisualResult['image'];
      let png: Buffer | undefined;
      if (request.target !== 'none') {
        const canvasClip = {
          x: surface.origin.x,
          y: surface.origin.y,
          width: Math.max(1, Math.min(surface.canvas.width, 20_000)),
          height: Math.max(1, Math.min(surface.canvas.height, 20_000)),
        };
        try {
          if (region) {
            png = await opened.session.screenshot({
              x: surface.origin.x + region.x - scrollX,
              y: surface.origin.y + region.y - scrollY,
              width: Math.min(region.width, canvasClip.width),
              height: Math.min(region.height, canvasClip.height),
            });
          } else if (request.target === 'full-page') {
            png = await opened.session.screenshot(canvasClip);
          } else {
            png = await opened.session.screenshot();
          }
        } catch (error) {
          if (region) {
            warnings.push(
              `widget crop failed (${messageOf(error)}); returned the whole canvas instead`,
            );
            png = await opened.session.screenshot(canvasClip);
          } else {
            throw new InfrastructureError('SCREENSHOT_FAILED', `cannot capture the page: ${messageOf(error)}`, {
              retryable: true,
              cause: error,
            });
          }
        }
      }

      if (surface.resized) {
        warnings.push(
          `the browser viewport was enlarged to ${surface.canvas.width}x${surface.canvas.height} so the prototype ` +
            'canvas renders at 1:1; a smaller viewport would have scaled the canvas down.',
        );
      }
      if (!surface.resized && request.viewport) {
        // The caller pinned the viewport, so the canvas may be larger than what was captured.
        const rendered = {
          width: scroll?.viewportWidth ?? this.#config.viewportWidth,
          height: scroll?.viewportHeight ?? this.#config.viewportHeight,
        };
        if (surface.canvas.width > rendered.width || surface.canvas.height > rendered.height) {
          warnings.push(
            `the canvas is ${surface.canvas.width}x${surface.canvas.height} but the viewport you pinned is ` +
              `${rendered.width}x${rendered.height}, so a full-page capture covers only the top-left part of the canvas. ` +
              'Omit `viewport` to let the server size it to the canvas, or capture specific widgets.',
          );
        }
      }

      // A save failure must not discard a successful capture: the pixels are reported either
      // way, and the failure becomes a warning instead of an error result.
      let savedTo: string | undefined;
      if (png && request.savePath) {
        try {
          savedTo = await this.#saveScreenshot(request.savePath, png);
        } catch (error) {
          warnings.push(`screenshot written to disk failed: ${messageOf(error)}`);
        }
      }

      if (png && request.includeImage) {
        if (png.byteLength > MAX_ATTACHABLE_IMAGE_BYTES) {
          warnings.push(
            `the PNG is ${Math.round(png.byteLength / 1024)} KiB, above the ${Math.round(
              MAX_ATTACHABLE_IMAGE_BYTES / 1024,
            )} KiB attach limit, so it was not attached as an image block. It is still reported here and written to disk ` +
              'if savePath was set; capture a widget crop or a region for something small enough to attach.',
          );
        } else {
          image = { bytes: png.byteLength, base64: png.toString('base64') };
        }
      }

      const result: VisualResult = {
        page: { id: pageId, name: opened.page.pageName ?? (title || pageId), url: neutralizeUntrusted(opened.session.url()) },
        target: request.target,
        space: request.space,
        canvas: surface.canvas,
        viewport: {
          width: scroll?.viewportWidth ?? this.#config.viewportWidth,
          height: scroll?.viewportHeight ?? this.#config.viewportHeight,
          scrollX,
          scrollY,
        },
        region,
        widgets,
        missingWidgets: missing.length ? missing : undefined,
        image,
        savedTo,
        warnings,
      };
      log.debug('visual captured', { target: request.target, bytes: png?.byteLength ?? 0, ms: Date.now() - started });
      return result;
    } finally {
      await opened.session.close();
    }
  }

  /** Write a screenshot inside the configured directory, never outside it. */
  async #saveScreenshot(savePath: string, png: Buffer): Promise<string> {
    const destination = resolveWithinBase(this.#config.screenshotDir, savePath);
    try {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, png);
      return destination;
    } catch (error) {
      throw new InfrastructureError('WRITE_FAILED', `cannot write ${destination}: ${messageOf(error)}`, {
        hint: 'Check that AXURE_SCREENSHOT_DIR exists and is writable by the account running the server.',
        cause: error,
      });
    }
  }

  /** Release the browser. */
  async dispose(): Promise<void> {
    await this.#adapter.dispose();
  }
}

/**
 * Every widget id an interaction record refers to.
 *
 * Collects the widget an interaction is *attached to* plus every target it names, including the
 * resolved panel id. These are the ids that must survive the node budget so no record in the
 * standard document points at an element the document does not contain.
 */
function collectInteractionWidgetIds(interactions: InteractionFact[]): Set<string> {
  const ids = new Set<string>();
  for (const fact of interactions) {
    ids.add(fact.widgetId);
    for (const branch of fact.branches ?? []) {
      for (const action of branch.actions) {
        if (action.panelId) ids.add(action.panelId);
        for (const target of action.targets ?? []) {
          if (target.widgetId) ids.add(target.widgetId);
        }
      }
    }
  }
  return ids;
}

/** Drop widgets whose dynamic-panel state is not active. */
function pruneHidden(nodes: PageMapResult['outline']): PageMapResult['outline'] {
  const out: PageMapResult['outline'] = [];
  for (const node of nodes) {
    if (!node.visible) continue;
    const copy = { ...node };
    if (node.children) {
      const children = pruneHidden(node.children);
      if (children.length) copy.children = children;
      else delete copy.children;
    }
    out.push(copy);
  }
  return out;
}



