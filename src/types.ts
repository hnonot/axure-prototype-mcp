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

/**
 * How much is actually known about one interaction.
 *
 * This field is the point of the feature: the iteration requires that a guess is never
 * presented as a confirmed result, so the evidence level travels **with the data** instead of
 * being implied by prose, and a consumer can filter on it mechanically.
 *
 * - `declared` — the Axure project model states this interaction. Fact.
 * - `observed` — the page was triggered and this is what changed. Fact, but only about the one
 *   branch that ran, so the set is necessarily incomplete.
 * - `inferred` — the widget merely looks interactive. A guess, and such a record never carries
 *   `branches`, because the action is not known.
 */
export type InteractionConfidence = 'declared' | 'observed' | 'inferred';

/** Where a record's evidence came from, so a consumer can weigh it. */
export type InteractionSource = 'axure-project-model' | 'dom-observation' | 'trigger-observation';

/** What a consumer has to do to fire the interaction. */
export type InteractionTrigger =
  | 'click'
  | 'double-click'
  | 'context-menu'
  | 'mouse-enter'
  | 'mouse-leave'
  | 'mouse-down'
  | 'mouse-up'
  | 'mouse-move'
  | 'focus'
  | 'blur'
  | 'key-down'
  | 'key-up'
  | 'text-change'
  | 'selection-change'
  | 'checked-change'
  | 'load'
  | 'page-load'
  | 'page-resize'
  | 'page-scroll'
  | 'swipe'
  | 'long-press'
  | 'unknown';

/** Normalized action kinds; the original label is always preserved in `rawType`. */
export type InteractionActionKind =
  | 'navigate'
  | 'open-url'
  | 'set-panel-state'
  | 'set-panel-state-back'
  | 'show'
  | 'hide'
  | 'toggle-visibility'
  | 'set-text'
  | 'set-value'
  | 'set-selected'
  | 'set-checked'
  | 'focus'
  | 'expand-collapse'
  | 'move'
  | 'rotate'
  | 'set-opacity'
  | 'scroll-to'
  | 'fire-event'
  | 'wait'
  | 'other';

/** One condition guarding a branch, when the model records it. */
export interface InteractionCondition {
  /** Left-hand side, e.g. `[[This.text]]`. */
  target?: string;
  /** Comparison operator token, e.g. `equals`, `contains`, `greater`. */
  operator?: string;
  /** Right-hand side of the comparison. */
  value?: string;
  /** The model's own plain-language rendering, e.g. `if is selected of This equals false`. */
  conditionString?: string;
  /** The model's own wording, when it is more specific than the fields above. */
  description?: string;
}

/** One target an action affects. */
export interface InteractionTarget {
  /** Axure widget id, when the target is a widget on this page. */
  widgetId?: string;
  /** Page id, for navigation actions. */
  pageId?: string;
  /** Page name, for navigation actions. */
  pageName?: string;
  /** Human-readable label the model supplied for an unresolvable target. */
  label?: string;
  /**
   * Whether `widgetId` exists in the page's DOM. `true`/`false` are measured; omitted means it
   * could not be determined. An unresolved target is reported rather than dropped, because
   * "the model names a widget that is not on this page" is itself useful information.
   */
  resolved?: boolean;
}

/** One thing an interaction does. */
export interface InteractionAction {
  kind: InteractionActionKind;
  /** The model's own readable label (Axure's `displayName`), preserved. */
  rawType?: string;
  /** The model's internal action token, kept when it differs from `rawType`. */
  internalType?: string;
  /** The model's own sentence describing the action, e.g. `Set is selected of This equal to "true"`. */
  description?: string;
  targets?: InteractionTarget[];
  /** Panel state index for `set-panel-state`, zero-based so it matches the page map's active state. */
  state?: number;
  /** The model's own 1-based state number, kept because it is what distinguishes expand/collapse. */
  stateNumber?: number;
  /** DOM id of the panel a `set-panel-state` action switches, resolved by the reader. */
  panelId?: string;
  /** Text or expression value for value-changing actions. */
  value?: string;
  /** Milliseconds, for `wait`. */
  delayMs?: number;
  /** Order within the branch. */
  order: number;
}

/** One conditional branch of a trigger. */
export interface InteractionBranch {
  /** Branch label the model supplied, e.g. `Case 1`. */
  name?: string;
  conditions?: InteractionCondition[];
  actions: InteractionAction[];
}

/** One interaction attached to a widget. */
export interface InteractionFact {
  /** `<pageId>#<widgetId>`, aligned with the outline's `ref`. */
  widgetRef: string;
  widgetId: string;
  /** Widget name or text, for readability. Untrusted. */
  widgetLabel?: string;
  trigger: InteractionTrigger;
  /** The model's raw event name, preserved. */
  rawTrigger?: string;
  confidence: InteractionConfidence;
  source: InteractionSource;
  /** Present for `declared` and `observed`; never for `inferred`. */
  branches?: InteractionBranch[];
  /** Present for `inferred`: why this widget is believed interactive. */
  inferredReason?: string;
  /** Non-fatal problems encountered while reading this interaction. */
  warnings?: string[];
}

/** A source that was looked for but could not be read. */
export interface InteractionGap {
  /** What was attempted, e.g. `axure-project-model`. */
  source: string;
  /** Why it did not work. */
  reason: string;
  /** What a consumer therefore cannot see. */
  impact: string;
}

/** Aggregate view of what the page contains. */
export interface InteractionStats {
  /** Widgets the page contains, as counted by the outline extractor. */
  widgets: number;
  /** Distinct widgets carrying at least one interaction record. */
  widgetsWithInteractions: number;
  /** Records per evidence level, so a consumer can see how much is guesswork. */
  byConfidence: Record<InteractionConfidence, number>;
  /** Action counts per normalized kind. */
  byActionKind: Record<string, number>;
  /** Total conditional branches across all declared interactions. */
  branches: number;
}

/** Result of analysing one page's interactions. */
export interface InteractionResult {
  page: {
    id: string;
    name: string;
    url: string;
    title: string;
    type: string;
    path: string[];
  };
  /** Every interaction found, ordered by widget then trigger. */
  interactions: InteractionFact[];
  stats: InteractionStats;
  /** Sources that were unavailable, stated instead of silently omitted. */
  gaps: InteractionGap[];
  warnings: string[];
}

/**
 * Options for analysing one page's interactions.
 *
 * There is deliberately no trigger/click option: this tool does not fire interactions. Firing
 * one changes page state, which is a different capability with a different risk profile, and it
 * is not enabled here. `observed` records therefore only appear if a future iteration adds that
 * capability deliberately.
 */
export interface InteractionRequest {
  /** Caller-supplied page reference: id, name, project-relative path, or URL. */
  page?: string;
  /**
   * Whether to include `inferred` records.
   *
   * Default `true`, so a consumer sees the guesses *and* can tell them apart by `confidence`.
   * Set `false` for a facts-only view.
   */
  includeInferred: boolean;
  /** Cap on model entries read, so a huge page cannot produce an unbounded response. */
  maxWidgets: number;
  viewport?: { width: number; height: number };
}
