/** Shared value types used by the Axure document model, the page outline and the tools. */

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

/** A rectangle in page coordinates. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle plus viewport-relative information and visibility. */
export interface Rect extends Bounds {
  /** Viewport-space position of the same rectangle, before scrolling. */
  vx: number;
  vy: number;
  /** Whether any part of the rectangle intersects the current viewport. */
  onScreen: boolean;
  /** Whether the widget is currently rendered (authored visibility + ancestor state). */
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
  /** Raw Axure widget type name, e.g. `Dynamic Panel`, `Rectangle`. */
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
}

/** Aggregated statistics describing one page. */
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

/** Options controlling how much detail one outline carries. */
export type DetailLevel = 'compact' | 'standard' | 'full';

/** Input for a page-view capture. */
export interface PageViewRequest {
  page?: string;
  space: GeometrySpace;
  detail: DetailLevel;
  maxNodes: number;
  charBudget: number;
  includeHidden: boolean;
  includeAccessibility: boolean;
  includeNotes: boolean;
  settleMs?: number;
  viewport?: { width: number; height: number };
}

/** Result of capturing one page. */
export interface PageViewResult {
  page: {
    id: string;
    name: string;
    url: string;
    title: string;
    type: string;
    /** Path of sitemap folders containing the page. */
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
  /** Page-level notes and annotations, when present. */
  notes?: Array<{ target: string; text: string }>;
  /** Playwright ARIA snapshot, offered only when explicitly requested. */
  accessibility?: string;
  warnings: string[];
}
