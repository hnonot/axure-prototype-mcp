/**
 * Cross-layer data types.
 *
 * Everything here is a plain data shape with no behaviour and no imports, so any layer may
 * depend on it without creating a cycle. Two groups live here deliberately side by side:
 *
 * - the **domain result** shapes (`PageMapResult`, `SitemapResult`, `VisualResult`) that the
 *   service layer produces and the MCP layer formats; and
 * - the **request option** shapes that the MCP layer validates and passes down.
 *
 * Keeping them together is what makes "the text output and `structuredContent` are two
 * renderings of one object" checkable by reading a single file.
 */

/** Where a widget bounds rectangle is expressed. */
export type GeometrySpace = 'page' | 'viewport';

/** Named widget kind derived from Axure's own widget taxonomy. */
export type WidgetKind =
  | 'widget'
  | 'group'
  | 'dynamic-panel'
  | 'panel-state'
  | 'repeater'
  | 'table'
  | 'table-cell'
  | 'inline-frame'
  | 'text'
  | 'image'
  | 'shape'
  | 'input'
  | 'vector'
  | 'menu';

/** A rectangle in the requested coordinate space. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Viewport-space position of the same rectangle, before scrolling. */
  vx: number;
  vy: number;
  /** Whether any part of the rectangle intersects the current viewport. */
  onScreen: boolean;
  /** Whether the widget is currently rendered (authored visibility plus active panel state). */
  visible: boolean;
}

/** Fill descriptor in `#rrggbb` or `rgba(...)` form. */
export interface Paint {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  opacity?: number;
}

/** Authored text style, reduced to the values an agent can reason about. */
export interface TextStyle {
  color?: string;
  size?: number;
  weight?: string;
  align?: string;
  valign?: string;
  font?: string;
  lineHeight?: number;
  padding?: [number, number, number, number];
}

/** One node of the flattened Axure outline. */
export interface OutlineNode extends Rect {
  /** Axure widget id inside its page, e.g. `u12`. */
  id: string;
  /** Stable handle for follow-up calls: `<pageId>#<widgetId>`. */
  ref: string;
  /** Nesting depth, 0 for page-level widgets. */
  depth: number;
  /** Named widget kind. */
  kind: WidgetKind;
  /** Axure widget type name, e.g. `Dynamic Panel`, `Rectangle`. */
  type: string;
  /** Designer-assigned widget name, when the prototype has one. */
  name?: string;
  /** Visible text owned by this widget. */
  text?: string;
  /** `true` when `text` was clipped to the per-node budget. */
  textTruncated?: boolean;
  /** Total number of characters in the untruncated text. */
  textLength?: number;
  /** Interaction affordance detected from the cursor style. */
  action?: 'click';
  style?: Paint;
  textStyle?: TextStyle;
  /** Image asset URL when the widget renders an image. */
  image?: string;
  /** Axure annotation / page-note text attached to the widget. */
  note?: string;
  /** Active dynamic-panel state index, when the widget is a dynamic panel. */
  state?: number;
  /** Number of authored dynamic-panel states. */
  stateCount?: number;
  /** Child nodes in DOM/source order. */
  children?: OutlineNode[];
  /** Set on an ancestor retained only to keep the hierarchy connected to a scoped match. */
  scoped?: boolean;
}

/** Aggregated statistics describing one page capture. */
export interface PageStats {
  widgets: number;
  nodes: number;
  visibleNodes: number;
  offCanvasNodes: number;
  truncatedNodes: number;
  omittedNodes: number;
  interactiveNodes: number;
  imageNodes: number;
}

/** How much per-node detail an outline carries. */
export type DetailLevel = 'compact' | 'standard' | 'full';

/** One page inside the Axure sitemap. */
export interface SitemapPage {
  /** Axure page id, e.g. `6k5oyo`. */
  id: string;
  name: string;
  /** Page URL relative to the project base URL. */
  url: string;
  /** Absolute page URL. */
  absoluteUrl: string;
  /** Folder path from the sitemap root, excluding the page itself. */
  path: string[];
  /** `Wireframe` or another Axure page type. */
  type: string;
}

/** Full sitemap projection, including folder structure. */
export interface SitemapResult {
  projectName: string;
  baseUrl: string;
  generatedAt: string;
  pageCount: number;
  folderCount: number;
  pages: SitemapPage[];
  /** Sitemap folders with the page ids they contain, in authoring order. */
  folders: Array<{ path: string[]; name: string; pageIds: string[] }>;
}

/** Restriction applied to one outline. */
export interface OutlineScope {
  region?: { x: number; y: number; width: number; height: number };
  widgetIds?: string[];
  onScreenOnly?: boolean;
  /** Widgets named in `widgetIds` that do not exist on the captured page. */
  missingWidgets?: string[];
}

/** Options controlling how one page is captured. */
export interface PageMapRequest {
  /** Caller-supplied page reference: id, name, project-relative path, or URL. */
  page?: string;
  space: GeometrySpace;
  detail: DetailLevel;
  maxNodes: number;
  charBudget: number;
  includeHidden: boolean;
  includeAccessibility: boolean;
  includeNotes: boolean;
  region?: { x: number; y: number; width: number; height: number };
  widgetIds?: string[];
  onScreenOnly?: boolean;
  settleMs?: number;
  viewport?: { width: number; height: number };
}

/** Result of capturing one page's structure and geometry. */
export interface PageMapResult {
  page: {
    id: string;
    name: string;
    url: string;
    title: string;
    type: string;
    /** Sitemap folders containing the page. */
    path: string[];
  };
  space: GeometrySpace;
  pageSize: { width: number; height: number };
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  detail: DetailLevel;
  stats: PageStats;
  outline: OutlineNode[];
  /** Omitted node count per reason, when the outline was trimmed. */
  omitted: Record<string, number>;
  /** Active scoping filters, echoed back so the caller can reason about coverage. */
  scope?: OutlineScope;
  /** Page-level notes and annotations, when present. */
  notes?: Array<{ target: string; text: string }>;
  /** Raw ARIA snapshot, offered only when explicitly requested. */
  accessibility?: string;
  warnings: string[];
}

/** What `axure_get_visual` should capture. */
export type VisualTarget = 'none' | 'viewport' | 'full-page' | 'widgets';

/** Options controlling one visual capture. */
export interface VisualRequest {
  page?: string;
  target: VisualTarget;
  widgetIds?: string[];
  space: GeometrySpace;
  /** Write the PNG here, relative to the configured screenshot directory. */
  savePath?: string;
  pad: number;
  /** Whether to attach the PNG as an image content block. */
  includeImage: boolean;
  viewport?: { width: number; height: number };
  settleMs?: number;
}

/** One widget's geometry as reported by a visual capture. */
export interface WidgetGeometry {
  id: string;
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Result of one visual capture. */
export interface VisualResult {
  page: { id: string; name: string; url: string };
  target: VisualTarget;
  space: GeometrySpace;
  canvas: { width: number; height: number };
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  /** Captured region in the requested coordinate space. */
  region?: { x: number; y: number; width: number; height: number };
  widgets: WidgetGeometry[];
  missingWidgets?: string[];
  /** PNG bytes, present only when a capture happened. */
  image?: { bytes: number; base64: string };
  savedTo?: string;
  warnings: string[];
}

/** The machine-readable failure shape returned in `structuredContent`. */
export interface ToolErrorResult {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    retryable: boolean;
  };
}
