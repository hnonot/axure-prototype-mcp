/**
 * Axure page outline: normalization, scoping, budgeting and statistics.
 *
 * This is the domain half of the extractor. `extract-source.ts` runs inside the browser and
 * returns raw nodes; this module turns them into the published outline shape and enforces
 * the budgets that keep one call inside a model's context window.
 *
 * It depends on the Playwright adapter only through the narrow `FrameHandle` interface, so
 * the whole domain can be unit-tested with a fake frame and no browser.
 */

import type { FrameHandle } from '../playwright/adapter.js';
import { InfrastructureError, messageOf } from '../errors.js';
import { neutralizeUntrusted, truncateWellFormed } from '../security.js';
import { EXTRACT_SOURCE, type RawCapture, type RawOutlineNode } from './extract-source.js';
import type { DetailLevel, OutlineNode, OutlineScope, PageMapRequest, PageStats, Paint, TextStyle } from '../types.js';

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Convert an Axure ARGB integer into a CSS colour. */
function argbToCss(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { fillType?: string; color?: number };
  if (record.fillType === 'none') return undefined;
  if (record.fillType && record.fillType !== 'solid') return String(record.fillType);
  if (typeof record.color !== 'number') return undefined;
  const n = record.color >>> 0;
  const a = ((n >>> 24) & 0xff) / 255;
  const r = (n >>> 16) & 0xff;
  const g = (n >>> 8) & 0xff;
  const b = n & 0xff;
  const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return a >= 0.999 ? hex : `rgba(${r},${g},${b},${round(a, 3)})`;
}

function paintOf(style: Record<string, unknown> | undefined): Paint | undefined {
  if (!style) return undefined;
  const isContainer = style.isContainer === true;
  const paint: Paint = {};
  const fill = isContainer ? undefined : argbToCss(style.fill);
  if (fill) paint.fill = fill;
  const stroke = argbToCss(style.borderFill);
  const strokeWidth = Number.parseFloat(String(style.borderWidth ?? ''));
  if (!isContainer && stroke && Number.isFinite(strokeWidth) && strokeWidth > 0) {
    paint.stroke = stroke;
    paint.strokeWidth = round(strokeWidth, 2);
  }
  const radius = Number.parseFloat(String(style.cornerRadius ?? ''));
  if (!isContainer && Number.isFinite(radius) && radius > 0) paint.radius = round(radius, 2);
  const opacity = Number.parseFloat(String(style.opacity ?? ''));
  if (Number.isFinite(opacity) && opacity < 1) paint.opacity = round(opacity, 3);
  return Object.keys(paint).length ? paint : undefined;
}

function textStyleOf(style: Record<string, unknown> | undefined): TextStyle | undefined {
  if (!style) return undefined;
  const out: TextStyle = {};
  const color = argbToCss(style.foreGroundFill);
  if (color) out.color = color;
  const size = Number.parseFloat(String(style.fontSize ?? ''));
  if (Number.isFinite(size)) out.size = round(size, 2);
  const weight = String(style.fontWeight ?? '');
  if (weight && weight !== '400' && weight !== 'normal') out.weight = weight;
  const align = String(style.horizontalAlignment ?? '');
  if (align && align !== 'left') out.align = align;
  const valign = String(style.verticalAlignment ?? '');
  if (valign && valign !== 'top') out.valign = valign;
  const lineHeight = Number.parseFloat(String(style.lineSpacing ?? ''));
  if (Number.isFinite(lineHeight)) out.lineHeight = round(lineHeight, 2);
  const font = String(style.fontName ?? '');
  if (font) out.font = font.split(',')[0]?.replace(/['"]/g, '').trim() || undefined;
  const padding = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map((key) =>
    Number.parseFloat(String(style[key] ?? '')),
  );
  if (padding.every((value) => Number.isFinite(value)) && padding.some((value) => value > 0)) {
    out.padding = padding as [number, number, number, number];
  }
  return Object.keys(out).length ? out : undefined;
}

/** Everything `normalizeNode` needs that does not change between siblings. */
interface NormalizeContext {
  pageId: string;
  space: PageMapRequest['space'];
  detail: DetailLevel;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  textBudget: number;
  stats: PageStats;
}

/** Convert one raw capture node into the published outline shape. */
function normalizeNode(raw: RawOutlineNode, context: NormalizeContext): OutlineNode | null {
  if (!raw || !raw.rect) return null;
  const rect = raw.rect;
  if (!(rect.width > 0) || !(rect.height > 0)) {
    context.stats.omittedNodes += 1;
    return null;
  }

  const pageX = rect.left;
  const pageY = rect.top;
  const useViewport = context.space === 'viewport';
  const intersects =
    pageX < context.scrollX + context.viewportWidth &&
    pageY < context.scrollY + context.viewportHeight &&
    pageX + rect.width > context.scrollX &&
    pageY + rect.height > context.scrollY;

  // Untrusted values are neutralized here, once, so that neither the text rendering nor
  // `structuredContent` can be tricked into emitting extra lines or forged sections.
  const id = neutralizeUntrusted(raw.id);
  const node: OutlineNode = {
    id,
    ref: `${context.pageId}#${id}`,
    depth: raw.depth,
    kind: raw.kind as OutlineNode['kind'],
    type: neutralizeUntrusted(raw.type),
    x: useViewport ? round(pageX - context.scrollX) : round(pageX),
    y: useViewport ? round(pageY - context.scrollY) : round(pageY),
    width: round(rect.width),
    height: round(rect.height),
    vx: round(pageX - context.scrollX),
    vy: round(pageY - context.scrollY),
    onScreen: intersects,
    visible: rect.visible === true,
  };
  if (raw.name) node.name = neutralizeUntrusted(raw.name);

  if (typeof raw.text === 'string') {
    const budget = Math.max(40, context.textBudget);
    if (raw.text.length > budget) {
      node.text = truncateWellFormed(raw.text, budget);
      node.textTruncated = true;
      context.stats.truncatedNodes += 1;
    } else {
      node.text = raw.text.toWellFormed();
    }
    node.textLength = raw.textLength ?? raw.text.length;
  }

  if (raw.action === 'click') node.action = 'click';
  if (raw.note) node.note = neutralizeUntrusted(raw.note);
  if (typeof raw.stateCount === 'number') node.stateCount = raw.stateCount;
  if (typeof raw.state === 'number') node.state = raw.state;
  if (raw.image) node.image = neutralizeUntrusted(raw.image);

  if (context.detail !== 'compact') {
    const paint = paintOf(raw.style);
    if (paint) node.style = paint;
  }
  if (context.detail === 'full') {
    const textStyle = textStyleOf(raw.style);
    if (textStyle) node.textStyle = textStyle;
  }

  if (raw.children?.length) {
    const children: OutlineNode[] = [];
    for (const child of raw.children) {
      const normalized = normalizeNode(child, context);
      if (normalized) children.push(normalized);
    }
    if (children.length) node.children = children;
  }
  return node;
}

/** Count one node plus its descendants. */
export function countNodes(node: OutlineNode): number {
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
}

/** Depth-first flatten. */
export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (list: OutlineNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Depth-first search for one widget by id. */
export function findNode(nodes: OutlineNode[], id: string): OutlineNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Keep only the parts of the outline the caller asked for.
 *
 * The match test is applied **per node**, and a surviving descendant keeps its ancestors
 * connected. It is deliberately *not* inherited downward: a large container that overlaps
 * the region (an 1891px-wide table, say) would otherwise drag every one of its far-away
 * cells into the result, which defeats the point of scoping.
 *
 * A widget named in `widgetIds` is the one exception — its descendants are all kept, so
 * "show me this panel" returns the panel's contents. Ancestors retained only for
 * connectivity are marked `scoped`.
 */
export function applyScope(
  nodes: OutlineNode[],
  scope: { region?: OutlineScope['region']; widgetIds?: string[]; onScreenOnly?: boolean },
): { nodes: OutlineNode[]; matchedIds: Set<string> } {
  const matchedIds = new Set<string>();
  const region = scope.region;
  const seedIds = new Set(scope.widgetIds ?? []);

  const intersectsRegion = (node: OutlineNode): boolean => {
    if (!region) return true;
    return (
      node.x < region.x + region.width &&
      node.x + node.width > region.x &&
      node.y < region.y + region.height &&
      node.y + node.height > region.y
    );
  };

  const visit = (node: OutlineNode, insideSeed: boolean): OutlineNode | null => {
    const descendSeed = insideSeed || seedIds.has(node.id);

    const children: OutlineNode[] = [];
    for (const child of node.children ?? []) {
      const kept = visit(child, descendSeed);
      if (kept) children.push(kept);
    }

    const isMatch = (descendSeed || intersectsRegion(node)) && (scope.onScreenOnly !== true || node.onScreen);

    if (isMatch) {
      matchedIds.add(node.id);
      const copy: OutlineNode = { ...node };
      if (children.length) copy.children = children;
      else delete copy.children;
      return copy;
    }
    if (children.length) {
      // Kept only to keep the hierarchy connected to a surviving descendant.
      return { ...node, children, scoped: true };
    }
    return null;
  };
  const out: OutlineNode[] = [];
  for (const node of nodes) {
    const kept = visit(node, false);
    if (kept) out.push(kept);
  }
  return { nodes: out, matchedIds };
}

/**
 * Bound the outline by node count, dropping the least useful nodes first.
 *
 * Omitting reasons are accumulated so the response can explain what was removed rather than
 * silently returning a partial page.
 */
/**
 * Expand a protected set to include the ancestors of every protected node.
 *
 * Protecting only the named nodes is not enough: the drop passes evaluate an ancestor before its
 * children, so a parent group holding a protected checkbox was itself removed and took the
 * protected child with it. That produced exactly the dangling references this is meant to prevent,
 * which is why the closure is computed here rather than checked inside the passes.
 */
function withAncestors(nodes: OutlineNode[], protectedIds?: ReadonlySet<string>): ReadonlySet<string> | undefined {
  if (!protectedIds || protectedIds.size === 0) return undefined;
  const effective = new Set(protectedIds);
  const walk = (list: OutlineNode[], ancestors: readonly string[]): void => {
    for (const node of list) {
      const chain = [...ancestors, node.id];
      if (protectedIds.has(node.id)) {
        for (const ancestor of ancestors) effective.add(ancestor);
      }
      if (node.children?.length) walk(node.children, chain);
    }
  };
  walk(nodes, []);
  return effective;
}

/**
 * Trim an outline to a node budget.
 *
 * @param protectedIds - widget ids that must survive the trim, together with their ancestors. The
 *   standard document carries structure and interactions together, and an interaction record that
 *   names a widget the element list had dropped is a dangling reference: a reader cannot tell what
 *   the interaction is *on*.
 */
export function applyBudgets(
  nodes: OutlineNode[],
  maxNodes: number,
  stats: PageStats,
  omitted: Record<string, number>,
  protectedIds?: ReadonlySet<string>,
): OutlineNode[] {
  let total = nodes.reduce((sum, node) => sum + countNodes(node), 0);
  if (total <= maxNodes) return nodes;

  const protectedClosure = withAncestors(nodes, protectedIds);
  const isProtected = (node: OutlineNode): boolean => protectedClosure?.has(node.id) === true;
  const clone = structuredClone(nodes) as OutlineNode[];

  const drop = (predicate: (node: OutlineNode) => boolean, reason: string): void => {
    const sweep = (list: OutlineNode[]): boolean => {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const node = list[index]!;
        if (node.children) sweep(node.children);
        if (predicate(node) && total > maxNodes && !isProtected(node)) {
          list.splice(index, 1);
          total -= countNodes(node);
          omitted[reason] = (omitted[reason] ?? 0) + 1;
          stats.omittedNodes += 1;
          return true;
        }
      }
      return false;
    };
    // Repeat until no further node matches; one pass per level would not be enough.
    let guard = 0;
    while (total > maxNodes && sweep(clone)) {
      guard += 1;
      if (guard > 20_000) break;
    }
  };

  drop((node) => node.kind === 'group' && (node.children ?? []).length === 0, 'empty-group');
  drop((node) => node.kind === 'panel-state', 'panel-state');
  drop((node) => !node.onScreen, 'off-canvas');
  drop((node) => !node.text && !node.action && node.kind === 'shape', 'decorative-shape');

  if (total > maxNodes) {
    // Last resort: keep the first maxNodes nodes in source order, except protected ones, which are
    // kept wherever they appear. Without that exemption the fallback would silently reintroduce the
    // dangling references the earlier passes were careful to avoid.
    const kept: OutlineNode[] = [];
    let count = 0;
    const walk = (list: OutlineNode[]): void => {
      for (const node of list) {
        if (count >= maxNodes && !isProtected(node)) {
          omitted['node-budget'] = (omitted['node-budget'] ?? 0) + 1;
          stats.omittedNodes += 1;
          continue;
        }
        const copy: OutlineNode = { ...node };
        delete copy.children;
        kept.push(copy);
        count += 1;
        if (node.children) walk(node.children);
      }
    };
    walk(clone);
    return kept;
  }
  return clone;
}

/** Statistics derived from a normalized outline. */
export function collectStats(nodes: OutlineNode[]): PageStats {
  const stats: PageStats = {
    widgets: 0,
    nodes: 0,
    visibleNodes: 0,
    offCanvasNodes: 0,
    truncatedNodes: 0,
    omittedNodes: 0,
    interactiveNodes: 0,
    imageNodes: 0,
  };
  for (const node of flattenOutline(nodes)) {
    stats.nodes += 1;
    if (node.visible) stats.visibleNodes += 1;
    if (!node.onScreen) stats.offCanvasNodes += 1;
    if (node.textTruncated) stats.truncatedNodes += 1;
    if (node.action) stats.interactiveNodes += 1;
    if (node.image) stats.imageNodes += 1;
  }
  return stats;
}

/** Outcome of one extraction pass. */
export interface CaptureOutcome {
  pageSize: { width: number; height: number };
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  stats: PageStats;
  outline: OutlineNode[];
  omitted: Record<string, number>;
  scope?: OutlineScope;
  notes: Array<{ target: string; text: string }>;
  accessibility?: string;
  warnings: string[];
}

/**
 * Extract, normalize, scope and budget one page.
 *
 * @param frame - content frame of an already-navigated Axure page.
 * @param request - validated caller options.
 * @param pageId - resolved page id, used to build stable widget refs.
 * @param protectWidgetIds - widget ids exempt from the node budget. The standard document passes
 *   the widgets its interaction records refer to, so no record can name an element the document
 *   omits. Passed separately from `request` because it is derived from a read, not from a caller.
 */
export async function capturePageMap(
  frame: FrameHandle,
  request: PageMapRequest,
  pageId: string,
  protectWidgetIds?: ReadonlySet<string>,
): Promise<CaptureOutcome> {
  let capture: RawCapture;
  try {
    capture = await frame.run<RawCapture>(EXTRACT_SOURCE, { includeNotes: request.includeNotes });
  } catch (error) {
    throw new InfrastructureError('RENDER_FAILED', `outline extraction failed: ${messageOf(error)}`, {
      retryable: true,
      hint: 'The content frame may have navigated or the prototype may have re-rendered mid-capture; retry the call.',
      cause: error,
    });
  }

  if (!capture?.ok) {
    throw new InfrastructureError('RENDER_FAILED', `outline extraction failed: ${capture?.reason ?? 'unknown reason'}`);
  }

  const warnings = [...(capture.warnings ?? [])];

  // Per-node text budget: keep the whole outline inside the caller's character budget.
  const widgetEstimate = Math.max(1, capture.totalWidgets);
  const textBudget = Math.max(60, Math.min(4_000, Math.floor(request.charBudget / widgetEstimate)));

  const stats: PageStats = {
    widgets: capture.totalWidgets,
    nodes: 0,
    visibleNodes: 0,
    offCanvasNodes: 0,
    truncatedNodes: 0,
    omittedNodes: 0,
    interactiveNodes: 0,
    imageNodes: 0,
  };
  const omitted: Record<string, number> = {};

  const context: NormalizeContext = {
    pageId,
    space: request.space,
    detail: request.detail,
    scrollX: capture.scrollX,
    scrollY: capture.scrollY,
    viewportWidth: capture.viewportWidth,
    viewportHeight: capture.viewportHeight,
    textBudget,
    stats,
  };

  const normalized: OutlineNode[] = [];
  for (const raw of capture.nodes ?? []) {
    const node = normalizeNode(raw, context);
    if (node) normalized.push(node);
  }

  const isScoped = request.region !== undefined || (request.widgetIds?.length ?? 0) > 0 || request.onScreenOnly === true;
  const scoped = isScoped
    ? applyScope(normalized, {
        region: request.region,
        widgetIds: request.widgetIds,
        onScreenOnly: request.onScreenOnly,
      })
    : { nodes: normalized, matchedIds: new Set<string>() };

  // Scope first, then budget: a scoped call should spend its budget on the requested area
  // rather than on trimming an already-deterministic set of unwanted nodes.
  const bounded = applyBudgets(scoped.nodes, request.maxNodes, stats, omitted, protectWidgetIds);
  const recounted = collectStats(bounded);
  recounted.widgets = capture.totalWidgets;
  recounted.omittedNodes = stats.omittedNodes;
  recounted.truncatedNodes = stats.truncatedNodes;

  const missingWidgets = (request.widgetIds ?? []).filter((id) => !findNode(normalized, id));

  if (isScoped) {
    warnings.push(
      `scoped capture: ${recounted.nodes} of ${capture.totalWidgets} widgets match` +
        (request.region
          ? `; region ${request.region.x},${request.region.y} ${request.region.width}x${request.region.height}`
          : '') +
        (request.widgetIds?.length ? `; seed widgets ${request.widgetIds.join(', ')}` : '') +
        '. Drop the scope to see the whole page.',
    );
    for (const id of missingWidgets) warnings.push(`seed widget not found on this page: ${id}`);
  }

  if (recounted.offCanvasNodes > 0 && request.space === 'viewport') {
    warnings.push(
      `${recounted.offCanvasNodes} nodes lie outside the ${capture.viewportWidth}x${capture.viewportHeight} viewport; ` +
        'their coordinates are negative or beyond the viewport. Use space=page for absolute page coordinates.',
    );
  }

  let accessibility: string | undefined;
  if (request.includeAccessibility) {
    try {
      accessibility = await frame.ariaSnapshot();
    } catch (error) {
      warnings.push(`aria snapshot unavailable: ${messageOf(error)}`);
    }
  }

  return {
    pageSize: { width: capture.docWidth, height: capture.docHeight },
    viewport: {
      width: capture.viewportWidth,
      height: capture.viewportHeight,
      scrollX: capture.scrollX,
      scrollY: capture.scrollY,
    },
    stats: recounted,
    outline: bounded,
    omitted,
    ...(isScoped
      ? {
          scope: {
            region: request.region,
            widgetIds: request.widgetIds,
            onScreenOnly: request.onScreenOnly,
            missingWidgets: missingWidgets.length ? missingWidgets : undefined,
          },
        }
      : {}),
    notes: capture.notes ?? [],
    accessibility,
    warnings,
  };
}

/** Parse a widget reference of the form `<pageId>#<widgetId>` or a bare widget id. */
export function parseWidgetRef(ref: string): { pageId?: string; widgetId: string } {
  const trimmed = ref.trim();
  const hash = trimmed.indexOf('#');
  if (hash >= 0) return { pageId: trimmed.slice(0, hash) || undefined, widgetId: trimmed.slice(hash + 1) };
  return { widgetId: trimmed };
}
