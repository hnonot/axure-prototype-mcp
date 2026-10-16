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
  /**
   * Which shape to return.
   *
   * `outline` (the default) is the legacy `PageMapResult`, unchanged. `standard` returns the
   * `axure.page/v1` document, which additionally carries provenance for every value, an explicit
   * parent/child and relation graph, a deduplicated text index, and the page's interactions — all
   * from the same page load. The default is what keeps existing callers working.
   */
  format?: OutputFormat;
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
  /**
   * Which shape to return.
   *
   * `interactions` (the default) is the legacy `InteractionResult`, unchanged. `standard` returns
   * the `axure.page/v1` document — the same unified shape `axure_get_page_map` produces when asked
   * for `format="standard"` — carrying this page's elements, relations and interactions together.
   */
  format?: OutputFormat;
}

/* ========================================================================== */
/* Standardized document, schema `axure.page/v1`                              */
/* ========================================================================== */
/*
 * The 0.2.1 standardization layer.
 *
 * ## Why a separate shape instead of reusing `PageMapResult`
 *
 * `PageMapResult` is a *presentation* of one capture. It mixes three kinds of statement with no way
 * to tell them apart: the prototype's own data (`type`, geometry, authored text), values this server
 * computed (`kind`, `onScreen`, `depth`), and things nobody determined (just leaving a field
 * undefined). A consumer cannot then answer "is this a fact or a guess?".
 *
 * The standard document makes that question answerable per value, and it unifies structure and
 * interactions into one document so a caller does not have to load the page twice and join two
 * shapes by hand.
 *
 * ## The rule these types exist to enforce
 *
 * **Business meaning is never inferred from a name, a text label or an appearance.**
 *
 * A widget named 订单管理 is not thereby "an order-management component"; a division whose cursor is
 * `pointer` is not thereby "a button". The types below enforce this rather than merely discouraging
 * it:
 *
 * - {@link StandardElement.role} is typed {@link Confidence} and may only be `derived` from
 *   *structural, non-semantic* evidence (the authored `friendlyType` token, a form tag, an image
 *   URL). When that evidence is missing it is `unknown` and carries a {@link UnknownReason}, so
 *   "nobody determined this" is a value rather than an absence.
 * - {@link StandardElement.authoredType} keeps the prototype's own token verbatim, so nothing is
 *   lost when the derived role is `unknown`.
 * - There is deliberately **no** field for inferred business purpose. Adding one would require
 *   inventing the evidence for it.
 */

/**
 * How much is known about one value.
 *
 * Three values, not two: `unknown` is a first-class statement, which is what makes
 * 「标记为未知」 possible instead of indistinguishable from an omitted field.
 */
export type Provenance =
  /** The prototype states it. Reported as read, not as interpreted. */
  | 'fact'
  /** This server computed it by a named rule. The rule is reportable and repeatable. */
  | 'derived'
  /** It was looked for and could not be determined. */
  | 'unknown';

/** A `fact` or `derived` value, with its provenance attached. */
export interface Known<T> {
  value: T;
  provenance: 'fact' | 'derived';
  /** How the value was arrived at, for `derived` values. */
  rule?: string;
}

/**
 * A value together with how much is known about it.
 *
 * Modelled as a discriminated union so a consumer must handle `unknown` before reading `value`;
 * TypeScript will not let `known.value` compile without a narrowing check.
 */
export type Confidence<T> =
  | Known<T>
  | {
      provenance: 'unknown';
      /** Why it could not be determined. Machine-readable. */
      reason: UnknownReason;
      /** Human-readable detail, when the reason alone is not enough. */
      detail?: string;
    };

/** Why something could not be determined. Every path to `unknown` names one. */
export type UnknownReason =
  /** The prototype has no attribute for this. */
  | 'not-authored'
  /** An attribute exists but this server does not recognize its value. */
  | 'unrecognized-value'
  /** Only appearance suggests it, and appearance is not evidence. */
  | 'appearance-only'
  /** Several readings are possible and none is more reliable. */
  | 'ambiguous'
  /** The reading layer was not asked for it, or not asked far enough. */
  | 'not-requested'
  /** Reading it failed. */
  | 'read-failed';

/**
 * A widget classification justified only by structural, non-semantic evidence.
 *
 * Note what is absent: no `button`, no `menu`, no `form`, no business nouns. A `Rectangle` that
 * opens a menu is still a `shape`; that it is *interactive* is stated separately by the interaction
 * section, as an evidence level, rather than folded into the role.
 */
export type StandardRole =
  /** A container whose only known property is that it holds other elements. */
  | 'container'
  /** A leaf with authored geometry and no more specific structural evidence. */
  | 'shape'
  /** Renders a text run. */
  | 'text'
  /** Carries an image asset URL. */
  | 'image'
  /** A form control, established by its tag name. */
  | 'input'
  /** Carries multiple authored states, exactly one active. */
  | 'state-container'
  /** Tiles authored children of one shape. */
  | 'repeating-container'
  /** Addresses other pages. */
  | 'navigation-container';

/** One element of the standardized hierarchy. */
export interface StandardElement {
  /** Raw prototype id, e.g. `u575`. Preserved so anything can be traced back. */
  id: string;
  /** Stable handle for follow-up calls: `<pageId>#<widgetId>`. */
  ref: string;
  /** Parent's `id`, absent for a top-level element. */
  parentId?: string;
  /** Child `id`s in source order, absent for a leaf. */
  childIds?: string[];
  /** Nesting depth, 0 for a top-level element. */
  depth: number;
  /** The prototype's own widget type token, verbatim. Never normalized. */
  authoredType: string;
  /** Derived classification. Falls back to `unknown` with a reason, never to a guess. */
  role: Confidence<StandardRole>;
  /** Authored widget name, when the prototype has one. Untrusted text. */
  name?: string;
  geometry: {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Whether any part intersects the current viewport. */
    onScreen: boolean;
    /** Whether the prototype currently renders it. */
    visible: boolean;
    provenance: 'derived';
    rule: string;
  };
  /** The element's own visible text. Untrusted. */
  text?: string;
  /** Text that was clipped to a budget, and the untruncated length. */
  textTruncated?: { length: number };
  /** Attributes the prototype authored, passed through with their own provenance. */
  attributes?: {
    style?: Paint;
    textStyle?: TextStyle;
    image?: string;
    /** Active index and count for a state container, as authored. */
    activeState?: number;
    stateCount?: number;
  };
  /** Designer annotation attached to this element. Untrusted. */
  note?: string;
  /** Interaction records attached to this element. */
  interactionRefs?: string[];
  /** Ids of relations this element participates in. */
  relationRefs?: string[];
  /** Set when an ancestor exists only to keep a scoped match connected upward. */
  scopedConnector?: true;
}

/** Kinds of relation between two elements. Derived from structure or from the project model. */
export type StandardRelationKind =
  /** Direct containment. Redundant with `parentId`/`childIds`, kept for a flat query surface. */
  | 'contains'
  /** An interaction on `from` names `to` as something it affects. */
  | 'targets'
  /** An interaction on `from` switches the active state of `to`. */
  | 'switches-state-of'
  /** A second element carries text identical to `from`'s. Only when deduplication collapsed them. */
  | 'duplicates-text-of';

/** One relation. */
export interface StandardRelation {
  id: string;
  kind: StandardRelationKind;
  /** Source element `id`. */
  from: string;
  /** Target element `id`. Absent when the target is not on this page. */
  to?: string;
  /** Evidence level of the interaction the relation came from, when it came from one. */
  evidence?: InteractionConfidence;
  provenance: 'fact' | 'derived';
  rule: string;
}

/** Text as reported for one element. */
export interface StandardTextNode {
  elementId: string;
  /** The text, already neutralized for untrusted framing. */
  text: string;
  provenance: 'fact';
  /** Where in the raw capture it came from, so it can be traced. */
  from: 'widget-text' | 'widget-note' | 'panel-state' | 'page-note';
}

/**
 * Page-level text view: every visible text run once, plus what deduplication collapsed.
 *
 * 「重复信息消除」 with an audit trail — the collapse is reported, never silent.
 */
export interface StandardTextIndex {
  /** Distinct texts, each with the elements that carry it. */
  entries: Array<{
    text: string;
    /** Elements carrying this exact text, in outline order. */
    elementIds: string[];
    /** How many occurrences were collapsed into this entry. Always ≥ 1. */
    occurrences: number;
    from: StandardTextNode['from'];
  }>;
  /** Total text occurrences before deduplication. */
  totalOccurrences: number;
  /** Distinct texts after deduplication. */
  distinctTexts: number;
  /** Runs dropped because they were empty or whitespace-only after normalization. */
  droppedEmpty: number;
}

/** The interaction section of the standard document. */
export interface StandardInteractions {
  /** Facts and labelled guesses, one record per widget+trigger. */
  items: InteractionFact[];
  /** Sources that could not be read. An empty list means everything was read. */
  gaps: InteractionGap[];
  stats: InteractionStats;
  /** Non-fatal notes from the reader and analyzer. */
  warnings: string[];
}

/**
 * The standardized page document.
 *
 * Shape is versioned by `schema`, which is the field a consumer should branch on. Treat the rest as
 * additive: new optional fields may appear within v1, but no field changes meaning in place.
 */
export interface StandardDocument {
  /** Constant `axure.page/v1`. Bump only for a breaking shape change. */
  schema: 'axure.page/v1';
  page: {
    id: string;
    name: string;
    url: string;
    title: string;
    authoredType: string;
    /** Sitemap folders containing the page. */
    path: string[];
  };
  capture: {
    space: GeometrySpace;
    detail: DetailLevel;
    canvas: { width: number; height: number };
    viewport: { width: number; height: number; scrollX: number; scrollY: number };
    /** The scope filters that were applied, echoed so coverage is auditable. */
    scope?: OutlineScope;
    at: string;
  };
  /** Top-level elements. Children are reachable through `childIds`. */
  elements: StandardElement[];
  /** Flat id → element map, so a consumer can resolve references without walking the tree. */
  elementsById: Record<string, StandardElement>;
  relations: StandardRelation[];
  text: StandardTextIndex;
  interactions: StandardInteractions;
  stats: StandardStats;
  /**
   * What was omitted and why. Present so a bounded response never looks like a complete page.
   */
  omitted: Record<string, number>;
  /** Anything that could not be read or determined, with its impact. */
  gaps: Array<{ source: string; reason: string; impact: string }>;
  warnings: string[];
}

/** Aggregate counts for the standard document. */
export interface StandardStats {
  /** Widgets the raw extractor saw, before any budget. */
  widgets: number;
  /** Elements present in the document after scoping and budgeting. */
  elements: number;
  /** Elements reachable at depth 0. */
  roots: number;
  /** Deepest nesting level present. */
  maxDepth: number;
  /** Elements whose role could be established from structural evidence. */
  rolesKnown: number;
  /** Elements whose role is explicitly `unknown`. */
  rolesUnknown: number;
  /** Role counts, keyed by role name; `unknown` is a key like any other. */
  byRole: Record<string, number>;
  relations: number;
  interactions: {
    total: number;
    declared: number;
    observed: number;
    inferred: number;
  };
}

/** Whether `axure_get_page_map` returns the legacy outline or the standard document. */
export type OutputFormat = 'outline' | 'standard';

/* ========================================================================== */
/* Runtime prototype selection                                                */
/* ========================================================================== */

/**
 * Request to point the server at a prototype address supplied in the conversation.
 *
 * The address is untrusted input, so it is **verified** rather than trusted: see
 * `src/axure/prototype-url.ts`. On success the host is admitted for the rest of the process, which
 * is what lets a caller read pages from it with the ordinary tools without editing `.env`.
 */
export interface UsePrototypeRequest {
  /** The prototype URL the caller named. Required: there is nothing to guess. */
  url: string;
  viewport?: { width: number; height: number };
  settleMs?: number;
  /** Bound on the returned page list, mirroring `axure_list_pages`. */
  maxPages: number;
  filter?: string;
}

/** Outcome of verifying and adopting a caller-supplied prototype address. */
export interface UsePrototypeResult {
  /** The verified address, normalized. */
  url: string;
  origin: string;
  host: string;
  /** Axure signals actually observed. Never empty on success. */
  signals: string[];
  /** Frames inspected while looking for the runtime. */
  frames: number;
  /** How the address was validated, so a reader can judge the strength of the check. */
  verifiedBy: 'axure-runtime-probe';
  /** Page title, when the prototype reports one. */
  title?: string;
  /** Whether `.env` already covered this host, in which case nothing new was admitted. */
  alreadyConfigured: boolean;
  /** Pages discovered, when the sitemap was readable. */
  pageCount?: number;
  /** A bounded prefix of the pages, so the caller can continue without a second call. */
  pages?: SitemapPage[];
  /** Folder paths seen, so the caller knows the shape without receiving every page. */
  folders?: string[];
  /** The sitemap could not be read; the prototype is still usable by page URL. */
  warnings: string[];
}

/**
 * What `axure_get_page_map` returns.
 *
 * A discriminated pair chosen by the request's `format`. `outline` is byte-for-byte the legacy
 * `PageMapResult`; `standard` is the `axure.page/v1` document.
 */
export type PageOutput =
  | { format: 'outline'; result: PageMapResult }
  | { format: 'standard'; result: StandardDocument };
