/**
 * Axure-aware page outline extraction.
 *
 * ## Why this module exists
 *
 * An Axure prototype published as a share link is a nested HTML document whose
 * widgets are plain `<div>` elements. Measurements on a real Axure 10 deployment
 * showed that the browser accessibility tree is close to useless as a structural
 * description of such a page: every widget surfaces as an anonymous `paragraph` or
 * `img` node with no role, no name, no nesting and no position, because Axure gives
 * its widgets no ARIA semantics. A pure ARIA approach therefore loses exactly the
 * information an agent needs.
 *
 * The markup itself, however, is rich and stable:
 *
 * - every widget is `<div id="u<number>">`, and its kind is emitted by Axure as the
 *   HTML comment immediately preceding it (`<!-- 会员中心 (Dynamic Panel) -->`);
 * - Axure's own runtime (`window.$axure.getRectAndStyleById`) resolves the authored
 *   geometry, fill, border, corner radius, text and image for every widget, which the
 *   authoring-authored model is a better source of truth than computed CSS;
 * - dynamic panels carry per-state containers (`u4_state0`, `u4_state1`, ...) whose
 *   inactive states are `display:none`, so "visible" is directly measurable.
 *
 * This module walks that structure inside the page and produces one flat, in-order,
 * bounded-size outline. It is deliberately thin: it selects and normalizes what Axure
 * already exposes instead of re-deriving layout, and it does not attempt OCR, image
 * understanding or interaction.
 */

import type { Page } from 'playwright';
import { AxureError } from './errors.js';
import type {
  GeometrySpace,
  OutlineNode,
  PageStats,
  PageViewRequest,
  PageViewResult,
  Paint,
  TextStyle,
} from './types.js';

/** Raw node shape returned by the injected DOM walker. */
interface RawNode {
  id: string;
  depth: number;
  kind: string;
  type: string;
  name?: string;
  text?: string;
  textLength?: number;
  action?: string;
  image?: string;
  state?: number;
  stateCount?: number;
  note?: string;
  rect: { left: number; top: number; width: number; height: number; visible: boolean };
  /** Authored style record; `isContainer` marks group/panel styles that are not painted. */
  style?: Record<string, unknown>;
  children?: RawNode[];
}

/** Result of the injected extraction pass. */
interface RawCapture {
  ok: boolean;
  reason?: string;
  frameUrl: string;
  docWidth: number;
  docHeight: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  totalWidgets: number;
  nodes: RawNode[];
  notes: Array<{ target: string; text: string }>;
  warnings: string[];
}

/**
 * The function body is serialized and evaluated inside the Axure content frame, so it
 * must be **plain JavaScript**: no imports, no closures over module scope, and no
 * TypeScript annotations. `npm test` compiles this string with `new Function` to prove
 * it is valid JavaScript, because a stray type annotation would otherwise only fail at
 * runtime, inside the browser, far from the edit that caused it.
 */
export const EXTRACT_SOURCE = String.raw`
function axureExtractOutline(options) {
  const warnings = [];
  const root = document.getElementById('base') || document.body;
  const widgetIdPattern = /^u\d+$/;
  const panelStatePattern = /^u(\d+)_state(\d+)$/;

  const ax = window.$axure;
  const styleApi = ax && typeof ax.getRectAndStyleById === 'function';
  if (!styleApi) warnings.push('Axure runtime style API unavailable; styles are omitted.');

  const styleCache = new Map();
  function authored(id) {
    if (!styleApi) return null;
    if (styleCache.has(id)) return styleCache.get(id);
    let value = null;
    try { value = ax.getRectAndStyleById(id) || null; } catch (e) { value = null; }
    styleCache.set(id, value);
    return value;
  }

  function argbToCss(value) {
    if (!value || typeof value !== 'object') return undefined;
    if (value.fillType === 'none') return undefined;
    if (value.fillType && value.fillType !== 'solid') return String(value.fillType);
    const n = typeof value.color === 'number' ? value.color >>> 0 : null;
    if (n === null) return undefined;
    const a = ((n >>> 24) & 0xff) / 255;
    const r = (n >>> 16) & 0xff;
    const g = (n >>> 8) & 0xff;
    const b = n & 0xff;
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (a >= 0.999) return hex;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + Math.round(a * 1000) / 1000 + ')';
  }

  function num(value) {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function cleanText(value) {
    if (typeof value !== 'string') return undefined;
    const text = value.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    return text.length ? text : undefined;
  }

  // Text that this widget owns: Axure renders each widget's text into a sibling
  // "u<id>_text" element. Text aggregated into a dynamic panel's own style object is
  // not used, because it duplicates the text of the child widgets.
  function ownText(el) {
    const textEl = el.querySelector(':scope > [id$="_text"]');
    if (!textEl) return undefined;
    const computed = getComputedStyle(textEl);
    if (computed.display === 'none' || computed.visibility === 'hidden') return undefined;
    return cleanText(textEl.innerText || textEl.textContent);
  }

  function kindOf(type, childTypes) {
    const isWidget = (name) => childTypes.indexOf(name) !== -1;
    switch (type) {
      case 'Dynamic Panel': return 'dynamic-panel';
      case 'Group': return isWidget('widget') ? 'group' : 'shape';
      case 'Repeater': return 'repeater';
      case 'Table': return 'table';
      case 'Inline Frame': return 'inline-frame';
      case 'Text Area':
      case 'Text Field':
      case 'List Box':
      case 'Combo Box':
      case 'Checkbox':
      case 'Radio Button':
      case 'Button': return 'input';
      case 'Menu':
      case 'Menu (Vertical)':
      case 'Menu (Horizontal)': return 'menu';
      case 'Vector':
      case 'SVG':
      case 'Icon': return 'vector';
      case 'Image':
      case 'Image Map': return 'image';
      case 'Rectangle':
      case 'Rounded Rectangle':
      case 'Ellipse':
      case 'Placeholder':
      case 'Horizontal Line':
      case 'Vertical Line':
      case 'Connector':
      case 'Snapshot': return 'shape';
      case 'Heading 1':
      case 'Heading 2':
      case 'Heading 3':
      case 'Label':
      case 'Paragraph':
      case 'Flow Shape':
      case 'Box':
      case 'Note':
      case 'Marker': return 'text';
      default: return childTypes.length ? 'group' : 'widget';
    }
  }

  // Axure emits the widget kind and designer name as the comment right before the div.
  function commentInfo(el) {
    let info = null;
    for (let node = el.previousSibling; node; node = node.previousSibling) {
      if (node.nodeType === 1) break;
      if (node.nodeType === 8) {
        const text = (node.nodeValue || '').trim();
        const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(text);
        if (match) info = { name: match[1].trim(), type: match[2].trim() };
        break;
      }
      if (node.nodeType === 3 && (node.nodeValue || '').trim()) break;
    }
    return info;
  }

  function isHidden(el, computed) {
    return computed.display === 'none' || computed.visibility === 'hidden';
  }

  function classList(el) {
    return (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }

  function imageOf(el) {
    const img = el.querySelector(':scope > img[id$="_img"], :scope > img');
    if (!img) return undefined;
    const src = img.getAttribute('src') || '';
    return src || undefined;
  }

  let totalWidgets = 0;
  const notes = [];
  function visit(el, depth) {
    if (!(el instanceof HTMLElement)) return null;
    const id = el.id;
    const computed = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const isWidget = widgetIdPattern.test(id);

    // A non-widget element (base, panel-state container, rendering sub-element such as
    // u1_text / u1_img) is transparent: its widget descendants are spliced into the
    // enclosing widget's child list so the outline never contains wrapper nodes.
    if (!isWidget) {
      const flattened = [];
      for (const child of Array.from(el.children)) {
        const childNode = visit(child, depth, rect);
        if (!childNode) continue;
        if ('sublist' in childNode) flattened.push(...childNode.sublist);
        else flattened.push(childNode.node);
      }
      if (flattened.length === 0) return null;
      return { sublist: flattened };
    }

    const children = [];
    for (const child of Array.from(el.children)) {
      const childNode = visit(child, depth + 1, rect);
      if (!childNode) continue;
      if ('sublist' in childNode) children.push(...childNode.sublist);
      else children.push(childNode.node);
    }

    totalWidgets += 1;

    const info = commentInfo(el);
    const type = info ? info.type : 'Unknown';
    const childTypes = classList(el);
    const authoredStyle = authored(id);
    const authoredRect = authoredStyle && authoredStyle.rect ? authoredStyle.rect : null;
    const style = authoredStyle && authoredStyle.style ? authoredStyle.style : null;

    const hidden = isHidden(el, computed);
    const width = Math.round((authoredRect ? authoredRect.width : rect.width) * 10) / 10;
    const height = Math.round((authoredRect ? authoredRect.height : rect.height) * 10) / 10;
    const left = Math.round((authoredRect ? authoredRect.left : rect.left + window.scrollX) * 10) / 10;
    const top = Math.round((authoredRect ? authoredRect.top : rect.top + window.scrollY) * 10) / 10;

    const node = {
      id,
      depth,
      kind: kindOf(type, childTypes),
      type,
      name: info && info.name && info.name !== 'Unnamed' ? info.name : undefined,
      rect: { left, top, width, height, visible: !hidden },
      style: style
        ? {
            fill: style.fill,
            borderFill: style.borderFill,
            borderWidth: style.borderWidth,
            cornerRadius: style.cornerRadius,
            opacity: style.opacity,
            fontName: style.fontName,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            foreGroundFill: style.foreGroundFill,
            horizontalAlignment: style.horizontalAlignment,
            verticalAlignment: style.verticalAlignment,
            paddingLeft: style.paddingLeft,
            paddingTop: style.paddingTop,
            paddingRight: style.paddingRight,
            paddingBottom: style.paddingBottom,
            lineSpacing: style.lineSpacing,
            image: style.image || null,
            isContainer: type === 'Group' || type === 'Dynamic Panel' || type === 'Repeater',
          }
        : undefined,
    };

    const text = ownText(el);
    if (text) {
      node.text = text;
      node.textLength = text.length;
    }

    if (computed.cursor === 'pointer') node.action = 'click';
    const image = imageOf(el);
    if (image) node.image = image;

    // Axure annotations are rendered into the widget's own note element.
    if (options.includeNotes) {
      const noteEl = el.querySelector('[id$="_note"], .ax_default_note');
      if (noteEl) {
        const noteText = cleanText(noteEl.innerText || noteEl.textContent);
        if (noteText) {
          node.note = noteText;
          notes.push({ target: id, text: noteText });
        }
      }
    }

    if (isPanelStateParent(el)) {
      const states = el.querySelectorAll(':scope > [id^="' + id + '_state"]');
      node.stateCount = states.length;
      for (const state of Array.from(states)) {
        const stateStyle = getComputedStyle(state);
        if (stateStyle.display !== 'none' && stateStyle.visibility !== 'hidden') {
          const index = Number.parseInt((state.id.split('_state')[1] || '0'), 10);
          node.state = Number.isFinite(index) ? index : 0;
          const label = state.getAttribute('data-label');
          if (label) node.name = node.name || label;
          break;
        }
      }
    }

    if (children.length) node.children = children;
    return { node };

    function isPanelStateParent(element) {
      return element.querySelector(':scope > [id^="' + id + '_state"]') !== null;
    }
  }

  const collected = [];
  for (const child of Array.from(root.children)) {
    const result = visit(child, 0, null);
    if (!result) continue;
    if (result.sublist) collected.push(...result.sublist);
    else collected.push(result.node);
  }

  return {
    ok: true,
    frameUrl: location.href,
    docWidth: document.documentElement.scrollWidth,
    docHeight: document.documentElement.scrollHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    totalWidgets,
    nodes: collected,
    notes,
    warnings,
  };
}
`;

/** Browser-side evaluator for the extraction source above. */
declare global {
  // eslint-disable-next-line no-var
  var axureExtractOutline: ((options: { includeNotes: boolean }) => RawCapture) | undefined;
}

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const paintOf = (style: Record<string, unknown> | undefined, argb: (value: unknown) => string | undefined): Paint | undefined => {
  if (!style) return undefined;
  const isContainer = style.isContainer === true;
  const paint: Paint = {};
  const fill = isContainer ? undefined : argb(style.fill);
  if (fill) paint.fill = fill;
  const stroke = argb(style.borderFill);
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
};

const argbToCss = (value: unknown): string | undefined => {
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
  if (a >= 0.999) return hex;
  return `rgba(${r},${g},${b},${round(a, 3)})`;
};

const textStyleOf = (style: Record<string, unknown> | undefined): TextStyle | undefined => {
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
};

/** Convert one raw capture node into the public outline shape. */
function normalizeNode(
  raw: RawNode,
  context: {
    pageId: string;
    space: GeometrySpace;
    detail: PageViewRequest['detail'];
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    docWidth: number;
    docHeight: number;
    textBudget: number;
    stats: PageStats;
  },
): OutlineNode | null {
  const { rect } = raw;
  if (rect.width <= 0 || rect.height <= 0) {
    context.stats.omittedNodes += 1;
    return null;
  }

  const pageX = raw.rect.left;
  const pageY = raw.rect.top;
  const useViewport = context.space === 'viewport';
  const x = useViewport ? round(pageX - context.scrollX) : round(pageX);
  const y = useViewport ? round(pageY - context.scrollY) : round(pageY);

  const intersects =
    pageX < context.scrollX + context.viewportWidth &&
    pageY < context.scrollY + context.viewportHeight &&
    pageX + rect.width > context.scrollX &&
    pageY + rect.height > context.scrollY;

  const node: OutlineNode = {
    id: raw.id,
    ref: `${context.pageId}#${raw.id}`,
    depth: raw.depth,
    kind: raw.kind as OutlineNode['kind'],
    type: raw.type,
    x,
    y,
    width: round(rect.width),
    height: round(rect.height),
    vx: round(pageX - context.scrollX),
    vy: round(pageY - context.scrollY),
    onScreen: intersects,
    visible: rect.visible,
  };
  if (raw.name) node.name = raw.name;

  const ownText = raw.text;
  if (ownText !== undefined) {
    const budget = Math.min(context.textBudget, Math.max(40, context.textBudget));
    if (ownText.length > budget) {
      node.text = `${ownText.slice(0, budget)}…`;
      node.textTruncated = true;
      context.stats.truncatedNodes += 1;
    } else {
      node.text = ownText;
    }
    node.textLength = raw.textLength ?? ownText.length;
  }

  if (raw.action) node.action = raw.action as 'click';
  if (raw.note) node.note = raw.note;
  if (raw.stateCount !== undefined) node.stateCount = raw.stateCount;
  if (raw.state !== undefined) node.state = raw.state;
  if (raw.image) node.image = raw.image;

  const rawStyle = raw.style as Record<string, unknown> | undefined;
  if (context.detail !== 'compact') {
    const paint = paintOf(rawStyle, argbToCss);
    if (paint) node.style = paint;
  }
  if (context.detail === 'full') {
    const textStyle = textStyleOf(rawStyle);
    if (textStyle) node.textStyle = textStyle;
  }

  if (raw.children) {
    const children: OutlineNode[] = [];
    for (const child of raw.children) {
      const normalized = normalizeNode(child, context);
      if (normalized) children.push(normalized);
    }
    if (children.length) node.children = children;
  }
  return node;
}

/** Count normalized nodes without mutating the tree. */
function countNodes(node: OutlineNode): number {
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
}

/**
 * Bound the outline: drop the least useful nodes first (zero-area nodes are already
 * gone, then dynamic-panel state containers, then off-canvas content) until both the
 * node and character budgets are respected.
 */
function applyBudgets(nodes: OutlineNode[], maxNodes: number, stats: PageStats, omitted: Record<string, number>): OutlineNode[] {
  let total = nodes.reduce((sum, node) => sum + countNodes(node), 0);
  if (total <= maxNodes) return nodes;

  const clone = structuredClone(nodes) as OutlineNode[];
  const drop = (predicate: (node: OutlineNode) => boolean, reason: string): boolean => {
    const walk = (list: OutlineNode[]): boolean => {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const node = list[index]!;
        if (node.children) walk(node.children);
        if (predicate(node) && total > maxNodes) {
          list.splice(index, 1);
          total -= countNodes(node);
          omitted[reason] = (omitted[reason] ?? 0) + 1;
          stats.omittedNodes += 1;
          return true;
        }
      }
      return false;
    };
    // Repeat until no further node matches, otherwise one pass per level is not enough.
    while (total > maxNodes && walk(clone)) { /* keep trimming */ }
    return total > maxNodes;
  };

  drop((node) => node.kind === 'group' && (node.children ?? []).length === 0, 'empty-group');
  drop((node) => node.kind === 'panel-state', 'panel-state');
  drop((node) => !node.onScreen, 'off-canvas');
  drop((node) => !node.text && !node.action && node.kind === 'shape', 'decorative-shape');

  if (total > maxNodes) {
    // Last resort: keep the first maxNodes nodes in source order.
    const kept: OutlineNode[] = [];
    let count = 0;
    const walk = (list: OutlineNode[]): void => {
      for (const node of list) {
        if (count >= maxNodes) {
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

/** Serialize one node as a single compact outline line. */
function renderNode(node: OutlineNode, space: GeometrySpace, detail: PageViewRequest['detail']): string {
  const indent = '  '.repeat(node.depth);
  const position = space === 'viewport'
    ? `@${node.x},${node.y}`
    : `@${node.x},${node.y}`;
  const parts = [`${indent}${node.id} ${node.kind}:${node.type} ${position} ${node.width}x${node.height}`];
  if (node.name) parts.push(`name=${JSON.stringify(node.name)}`);
  const flags: string[] = [];
  if (!node.visible) flags.push('hidden');
  if (!node.onScreen) flags.push('off-canvas');
  if (node.action) flags.push('clickable');
  if (node.stateCount !== undefined) flags.push(`states=${node.stateCount}`);
  if (node.state !== undefined) flags.push(`active=${node.state}`);
  if (node.image) flags.push('image');
  if (flags.length) parts.push(flags.join(','));
  if (node.text) parts.push(`text=${JSON.stringify(node.text)}`);
  if (node.note) parts.push(`note=${JSON.stringify(node.note)}`);
  if (detail !== 'compact' && node.style) {
    const style = Object.entries(node.style)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    if (style) parts.push(`[${style}]`);
  }
  if (detail === 'full' && node.textStyle) {
    const textStyle = Object.entries(node.textStyle)
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : String(value)}`)
      .join(' ');
    if (textStyle) parts.push(`{${textStyle}}`);
  }
  return parts.join(' ');
}

/** Render the outline as an indented, position-carrying markdown-ish tree. */
export function renderOutline(result: PageViewResult): string {
  const lines: string[] = [];
  lines.push(`# ${result.page.name}  [${result.page.id}]`);
  lines.push(
    `url: ${result.page.url}\n` +
      `page: ${result.pageSize.width}x${result.pageSize.height}px  ` +
      `viewport: ${result.viewport.width}x${result.viewport.height}px  ` +
      `scroll: ${result.viewport.scrollX},${result.viewport.scrollY}  ` +
      `space: ${result.space}`,
  );
  if (result.page.path.length) lines.push(`sitemap: ${result.page.path.join(' / ')}`);
  lines.push(
    `stats: ${result.stats.nodes} nodes / ${result.stats.widgets} widgets, ` +
      `${result.stats.offCanvasNodes} off-canvas, ${result.stats.interactiveNodes} clickable, ` +
      `${result.stats.imageNodes} images` +
      (Object.keys(result.omitted).length
        ? `, omitted: ${Object.entries(result.omitted).map(([key, value]) => `${key}=${value}`).join(' ')}`
        : ''),
  );
  lines.push(
    `format: <id> <kind>:<AxureType> @<x>,<y> <w>x<h> [name=] [hidden|off-canvas|clickable|states=n|active=n|image] ` +
      `[text=""] [note=""] [fill= stroke= radius= ...]`,
  );
  if (result.warnings.length) {
    for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  }
  if (result.notes?.length) {
    lines.push('\n## annotations');
    for (const note of result.notes) lines.push(`- ${note.target}: ${note.text.replace(/\n/g, ' / ')}`);
  }
  lines.push('\n## outline');
  for (const node of result.outline) {
    const stack: OutlineNode[] = [node];
    while (stack.length) {
      const current = stack.pop()!;
      lines.push(renderNode(current, result.space, result.detail));
      const children = current.children ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
    }
  }
  if (result.accessibility) {
    lines.push('\n## dom aria snapshot (roles/names only; Axure widgets expose none)');
    lines.push('```yaml');
    lines.push(result.accessibility.trimEnd());
    lines.push('```');
  }
  return lines.join('\n');
}

/** Depth-first flatten used by tooling that wants a list instead of a tree. */
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

/** Statistics derived from a normalized outline. */
export function collectStats(nodes: OutlineNode[], widgets: number, docSpace: { scrollX: number; scrollY: number; viewportWidth: number; viewportHeight: number }): PageStats {
  const stats: PageStats = {
    widgets,
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
  void docSpace;
  return stats;
}

/**
 * Locate the Axure **content** frame, the one that holds the page's widgets.
 *
 * An Axure share link is a two-level document: the outer shell owns the project
 * document model (`$axure.document.sitemap`) while the selected page is rendered into
 * the `mainFrame` iframe, which in turn owns the widget DOM. Both frames expose a
 * `$axure` object, so they must be told apart: only the content frame has elements
 * under `#base`.
 */
export async function findContentFrame(page: Page): Promise<import('playwright').Frame> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    for (const frame of page.frames()) {
      const probe = await frame
        .evaluate(() => ({
          widgets: document.querySelectorAll('#base [id^="u"]').length,
        }))
        .catch(() => null);
      if (probe && probe.widgets > 0) return frame;
    }
    if (Date.now() > deadline) {
      throw new AxureError(
        'NO_CONTENT_FRAME',
        'no Axure content frame with rendered widgets was found on the loaded page',
        'the URL must point at an Axure share/publish link; a page under /files/<name>/ renders directly while the project root uses the #mainFrame shell.',
      );
    }
    await page.waitForTimeout(250);
  }
}

/** Locate the frame that owns the Axure project document (the share shell). */
export async function findShellFrame(page: Page): Promise<import('playwright').Frame> {
  const probe = () =>
    page
      .evaluate(() => {
        const ax = (window as unknown as { $axure?: { document?: { sitemap?: unknown } } }).$axure;
        return !!(ax && typeof ax === 'object' && ax.document && ax.document.sitemap);
      })
      .catch(() => false);

  if (await probe()) return page.mainFrame();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await probe()) return page.mainFrame();
    await page.waitForTimeout(250);
  }
  throw new AxureError(
    'NOT_AXURE_PROJECT',
    'the loaded page did not expose an Axure project document',
    'point AXURE_URL at the project root share link, for example http://host/PROJECTID.',
  );
}

/** Inject the extractor and collect one page outline. */
export async function extractPageView(
  page: Page,
  frame: import('playwright').Frame,
  request: PageViewRequest,
): Promise<Omit<PageViewResult, 'page' | 'detail'> & { pageId: string; frameUrl: string; notes: RawCapture['notes'] }> {
  let capture: RawCapture;
  try {
    // The extractor is compiled inside the page with `new Function`, which keeps it
    // working under Axure's Content-Security-Policy (an injected `<script>` tag is
    // silently blocked there) and needs no cooperation from the page.
    capture = await frame.evaluate(
      ({ source, options }) => {
        const factory = new Function(`${source}; return axureExtractOutline;`)() as (
          opts: { includeNotes: boolean },
        ) => RawCapture;
        return factory(options);
      },
      { source: EXTRACT_SOURCE, options: { includeNotes: request.includeNotes } },
    );
  } catch (error) {
    throw new AxureError(
      'RENDER_FAILED',
      `outline extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      'the content frame may have navigated or the prototype may have re-rendered mid-capture; retry the call.',
    );
  }

  if (!capture?.ok) {
    throw new AxureError('RENDER_FAILED', `outline extraction failed: ${capture?.reason ?? 'unknown reason'}`);
  }

  const warnings = [...capture.warnings];
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

  // Per-node text budget: keep the whole outline inside the caller's character budget.
  const widgetEstimate = Math.max(1, capture.totalWidgets);
  const textBudget = Math.max(60, Math.min(4_000, Math.floor(request.charBudget / widgetEstimate)));

  const context = {
    pageId: '',
    space: request.space,
    detail: request.detail,
    scrollX: capture.scrollX,
    scrollY: capture.scrollY,
    viewportWidth: capture.viewportWidth,
    viewportHeight: capture.viewportHeight,
    docWidth: capture.docWidth,
    docHeight: capture.docHeight,
    textBudget,
    stats,
  };

  const normalized: OutlineNode[] = [];
  for (const raw of capture.nodes) {
    const node = normalizeNode(raw, context);
    if (node) normalized.push(node);
  }

  const bounded = applyBudgets(normalized, request.maxNodes, stats, omitted);
  const recounted = collectStats(bounded, capture.totalWidgets, {
    scrollX: capture.scrollX,
    scrollY: capture.scrollY,
    viewportWidth: capture.viewportWidth,
    viewportHeight: capture.viewportHeight,
  });
  recounted.omittedNodes = stats.omittedNodes;
  recounted.truncatedNodes = stats.truncatedNodes;
  recounted.widgets = capture.totalWidgets;

  if (recounted.offCanvasNodes > 0 && request.space === 'viewport') {
    warnings.push(
      `${recounted.offCanvasNodes} nodes lie outside the ${capture.viewportWidth}x${capture.viewportHeight} viewport; ` +
        'their coordinates are negative or beyond the viewport. Use space=page for absolute page coordinates.',
    );
  }

  let accessibility: string | undefined;
  if (request.includeAccessibility) {
    try {
      accessibility = await frame.locator('body').ariaSnapshot({ timeout: 20_000 });
    } catch (error) {
      warnings.push(`aria snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    pageId: '',
    frameUrl: capture.frameUrl,
    space: request.space,
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
    notes: capture.notes,
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
