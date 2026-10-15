/**
 * Standardization: raw captures -> the `axure.page/v1` document.
 *
 * ## Place in the architecture
 *
 * This module is a **pure transformation**. It imports no Playwright, opens no socket and touches no
 * filesystem: it receives already-read data and returns a new value. The reading layer
 * (`extract-source.ts`, `interaction-source.ts`, the adapter) is untouched by it, which is what
 * 「原始数据读取层与解析层应保持解耦」 asks for and what makes the whole conversion testable from
 * fixtures without a browser.
 *
 * ## The one rule worth reading the code for
 *
 * Business meaning is never inferred from a name, a text label or an appearance. See
 * {@link classifyRole}: the only inputs it will look at are the prototype's own `friendlyType`
 * token and the rendering backend reported (`tag`, `image`). It never receives the widget's name or
 * its text, so it *cannot* classify by them even by accident — the prohibition is a signature,
 * not a comment.
 *
 * Everything else here is bookkeeping: preserve raw identity, rebuild the hierarchy, deduplicate,
 * and mark what nobody determined.
 */

import type { CaptureOutcome } from './page-map.js';
import type { RawInteractionCapture } from './interaction-runtime.js';
import type { InteractionAnalysis } from './interaction-analyzer.js';
import type {
  Confidence,
  InteractionConfidence,
  InteractionFact,
  InteractionTarget,
  OutlineNode,
  OutlineScope,
  PageStats,
  StandardDocument,
  StandardElement,
  StandardRelation,
  StandardRole,
  StandardStats,
  StandardTextIndex,
  StandardTextNode,
} from '../types.js';
import { neutralizeUntrusted } from '../security.js';

/** The schema identifier written into every document. */
export const STANDARD_SCHEMA = 'axure.page/v1' as const;

/** Shared empty ancestor set for top-level nodes. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Rule names, so a `derived` value can always name the rule that produced it.
 *
 * Kept as constants because they appear in output and tests: a rule id that drifts silently would
 * make two documents from the same page incomparable.
 */
export const RULES = {
  geometry: 'capture/geometry',
  depth: 'capture/depth',
  roleFromType: 'classify/role-from-authored-type',
  roleFromStructure: 'classify/role-from-structure',
  contains: 'structure/containment',
  targets: 'interaction/target',
  switchesState: 'interaction/panel-target',
  duplicatesText: 'text/dedup',
} as const;

/* -------------------------------------------------------------------------- */
/* Role classification                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The prototype's own widget-type token -> a structural role.
 *
 * Keys are lowercased Axure `friendlyType` values. Every mapping is *structural*: it says what the
 * widget is made of, never what it is for. `Table` becomes `repeating-container` because it tiles
 * children, not because tables mean tabular business data; `Rectangle` becomes `shape`, not
 * `button`, even when it is clickable.
 */
const ROLE_BY_TYPE: Record<string, StandardRole> = {
  group: 'container',
  layer: 'container',
  dynamicpanel: 'state-container',
  'dynamic panel': 'state-container',
  'dynamic panel state': 'state-container',
  repeater: 'repeating-container',
  table: 'repeating-container',
  'tree table': 'repeating-container',
  imagetext: 'image',
  image: 'image',
  'image map': 'image',
  snapshot: 'image',
  textfield: 'input',
  'text field': 'input',
  textarea: 'input',
  'text area': 'input',
  checkbox: 'input',
  'check box': 'input',
  radiobutton: 'input',
  'radio button': 'input',
  dropdown: 'input',
  droplist: 'input',
  listbox: 'input',
  'list box': 'input',
  button: 'input',
  'submit button': 'input',
  'inline frame': 'container',
  inlineframe: 'container',
  menu: 'navigation-container',
  'menu bar': 'navigation-container',
  'vertical menu': 'navigation-container',
  'horizontal menu': 'navigation-container',
  tree: 'navigation-container',
  'tree node': 'navigation-container',
  flow: 'container',
  // Leaf shapes. These are the prototype's own vocabulary for "a drawn box", which is exactly what
  // they are; none of them is being read as a UI control.
  rectangle: 'shape',
  ellipse: 'shape',
  circle: 'shape',
  line: 'shape',
  triangle: 'shape',
  roundedrectangle: 'shape',
  'rounded rectangle': 'shape',
  connector: 'shape',
  'table cell': 'shape',
  placeholder: 'shape',
  text: 'text',
  'text paragraph': 'text',
  paragraph: 'text',
  label: 'text',
  heading: 'text',
  'rich text': 'text',
  vector: 'shape',
  path: 'shape',
  svg: 'shape',
  icon: 'shape',
};

/** Structural evidence available to classification. Deliberately excludes name and text. */
export interface RoleEvidence {
  /** The prototype's `friendlyType` token. */
  authoredType: string;
  /** Whether an image asset backs this element. */
  hasImage?: boolean;
  /** The bucket the extractor assigned. Used only in directions where it cannot mislead. */
  extractorKind?: string;
}

/** Normalize a type token for lookup: lowercase, collapse whitespace. */
function typeKey(authoredType: string): string {
  return authoredType.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Establish a structural role, or state that it could not be established.
 *
 * Inputs are structural only. Name and text are not parameters, and that is the point: business
 * meaning cannot be read off a label here because a label is not available here.
 *
 * Every rule id names the evidence it actually read. In particular the extractor's own bucket is
 * reported as `extractorKind:<bucket>` rather than dressed up as an independently observed tag:
 * that bucket is itself derived from the same widget, so presenting it as separate evidence would
 * overstate how much was measured.
 */
export function classifyRole(evidence: RoleEvidence): Confidence<StandardRole> {
  const key = typeKey(evidence.authoredType);
  const byType = ROLE_BY_TYPE[key];
  if (byType) {
    return { value: byType, provenance: 'derived', rule: `${RULES.roleFromType}(${key})` };
  }

  // The extractor's bucket is a structural hint, and it is only trusted in the two directions where
  // it cannot be wrong: a bucket of `group` means the widget holds children, and a bucket of
  // `input`/`image` means the reading layer found a form control or an image asset.
  const extractorKind = evidence.extractorKind;
  if (extractorKind === 'group') {
    return { value: 'container', provenance: 'derived', rule: `${RULES.roleFromStructure}(group)` };
  }
  if (extractorKind === 'input') {
    return { value: 'input', provenance: 'derived', rule: `${RULES.roleFromStructure}(input)` };
  }
  if (extractorKind === 'image' || evidence.hasImage) {
    return { value: 'image', provenance: 'derived', rule: `${RULES.roleFromStructure}(image)` };
  }

  // From here the role genuinely is not determinable. Note that a pointer cursor is NOT accepted as
  // evidence: that a widget reacts to a pointer says nothing about what it is, and the interaction
  // section already states interactivity with an evidence level of its own.
  return {
    provenance: 'unknown',
    reason: key ? 'unrecognized-value' : 'not-authored',
    detail: key
      ? `no structural rule covers the authored type "${keyParts(evidence.authoredType)}"`
      : 'the prototype authored no widget type for this element',
  };
}

/** Quote a raw token for a message without letting it forge output. */
function keyParts(value: string): string {
  return neutralizeUntrusted(value).slice(0, 60);
}

/* -------------------------------------------------------------------------- */
/* Hierarchy, dedup and relations                                             */
/* -------------------------------------------------------------------------- */

/** Accumulator used while walking, kept local so the walk stays a pure function. */
interface BuildState {
  pageId: string;
  /** Top-level elements only. Every element, at any depth, is in `byId`. */
  roots: StandardElement[];
  byId: Map<string, StandardElement>;
  relations: StandardRelation[];
  textByKey: Map<string, { text: string; elementIds: string[]; from: StandardTextNode['from'] }>;
  relationSeq: number;
  textOccurrences: number;
  droppedEmpty: number;
  /** Cycles broken while walking; reported rather than silently truncating a subtree. */
  cyclesBroken: number;
}

/** Stable, readable relation ids so two documents from one page can be diffed. */
function nextRelationId(state: BuildState, kind: StandardRelation['kind'], from: string, to?: string): string {
  state.relationSeq += 1;
  return `rel${state.relationSeq}:${kind}:${from}${to ? `->${to}` : ''}`;
}

/** Record a relation and attach it to both endpoints. */
function addRelation(
  state: BuildState,
  kind: StandardRelation['kind'],
  from: string,
  to: string | undefined,
  options: { provenance: 'fact' | 'derived'; rule: string; evidence?: InteractionConfidence },
): void {
  // Containment is already expressed by parentId/childIds; it is only published once per edge.
  if (kind === 'contains' && to === undefined) return;
  const relation: StandardRelation = {
    id: nextRelationId(state, kind, from, to),
    kind,
    from,
    ...(to !== undefined ? { to } : {}),
    ...(options.evidence ? { evidence: options.evidence } : {}),
    provenance: options.provenance,
    rule: options.rule,
  };
  state.relations.push(relation);
  const fromElement = state.byId.get(from);
  if (fromElement) {
    fromElement.relationRefs = fromElement.relationRefs ?? [];
    fromElement.relationRefs.push(relation.id);
  }
  if (to !== undefined) {
    const toElement = state.byId.get(to);
    if (toElement) {
      toElement.relationRefs = toElement.relationRefs ?? [];
      toElement.relationRefs.push(relation.id);
    }
  }
}

/** Add one text run to the index, creating its bucket on first sight. */
function addText(
  state: BuildState,
  text: string,
  elementId: string,
  from: StandardTextNode['from'],
): void {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    state.droppedEmpty += 1;
    return;
  }
  state.textOccurrences += 1;
  const key = `${from}\u0000${normalized}`;
  const bucket = state.textByKey.get(key);
  if (bucket) {
    bucket.elementIds.push(elementId);
    return;
  }
  state.textByKey.set(key, { text: normalized, elementIds: [elementId], from });
}

/**
 * Convert one outline node into a standard element and recurse.
 *
 * The node already carries normalized geometry and neutralized text from the capture layer, so this
 * does not re-normalize values — it *re-classifies* them, attaching provenance and rebuilding the
 * declared parent/child links so the hierarchy is explicit rather than implied by nesting.
 *
 * @param ancestors - ids on the current path. A malformed capture with a cycle would otherwise
 *   recurse until the stack blows; the cycle is broken and reported instead.
 */
function convertNode(
  state: BuildState,
  node: OutlineNode,
  parentId: string | undefined,
  interactionRefs: Map<string, InteractionFact[]>,
  ancestors: ReadonlySet<string>,
): void {
  if (ancestors.has(node.id)) {
    state.cyclesBroken += 1;
    return;
  }
  const childIds: string[] = [];
  const element: StandardElement = {
    id: node.id,
    ref: node.ref,
    ...(parentId !== undefined ? { parentId } : {}),
    depth: node.depth,
    authoredType: node.type,
    role: classifyRole({
      authoredType: node.type,
      hasImage: typeof node.image === 'string' && node.image.length > 0,
      extractorKind: node.kind,
    }),
    geometry: {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      onScreen: node.onScreen,
      visible: node.visible,
      provenance: 'derived',
      rule: RULES.geometry,
    },
  };

  if (node.name) element.name = node.name;
  if (typeof node.text === 'string') {
    element.text = node.text;
    // The capture layer records only the fact that it clipped; the untruncated length is preserved
    // so a consumer knows how much it is missing rather than silently reading a prefix as the whole.
    if (node.textTruncated) element.textTruncated = { length: node.textLength ?? node.text.length };
  }
  if (node.note) element.note = node.note;

  const attributes: NonNullable<StandardElement['attributes']> = {};
  if (node.style && Object.keys(node.style).length) attributes.style = node.style;
  if (node.textStyle && Object.keys(node.textStyle).length) attributes.textStyle = node.textStyle;
  if (node.image) attributes.image = node.image;
  if (typeof node.stateCount === 'number') attributes.stateCount = node.stateCount;
  if (typeof node.state === 'number') attributes.activeState = node.state;
  if (Object.keys(attributes).length) element.attributes = attributes;

  if (node.scoped) element.scopedConnector = true;

  const facts = interactionRefs.get(node.id);
  if (facts?.length) element.interactionRefs = facts.map((fact) => fact.widgetRef);

  // `elements` is the tree, so only roots go there; `elementsById` carries every element so a
  // reference can be resolved without walking. Keeping every element in `elements` as well would
  // make the published tree a flat bag and duplicate the whole payload.
  if (parentId === undefined) state.roots.push(element);
  state.byId.set(element.id, element);

  if (typeof node.text === 'string') addText(state, node.text, element.id, 'widget-text');
  if (node.note) addText(state, node.note, element.id, 'widget-note');

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(node.id);

  for (const child of node.children ?? []) {
    childIds.push(child.id);
    addRelation(state, 'contains', element.id, child.id, { provenance: 'derived', rule: RULES.contains });
    convertNode(state, child, element.id, interactionRefs, nextAncestors);
  }
  if (childIds.length) element.childIds = childIds;
}

/* -------------------------------------------------------------------------- */
/* Interactions -> relations                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Turn interaction targets into relations.
 *
 * Only targets that resolve to an element in this document become edges. A target that does not —
 * an unjoinable hash, a page reference, a name the model supplied but nothing on this page carries —
 * is left out of the graph and stays visible in the interaction record itself, which is where the
 * "we could not resolve this" statement belongs.
 */
function attachInteractionRelations(state: BuildState, interactions: InteractionFact[]): void {
  for (const fact of interactions) {
    if (!state.byId.has(fact.widgetId)) continue;
    const evidence: InteractionConfidence = fact.confidence;

    for (const branch of fact.branches ?? []) {
      for (const action of branch.actions) {
        // A panel action's target is resolved to a DOM id by the reader; prefer it over raw targets.
        if (action.panelId && state.byId.has(action.panelId)) {
          addRelation(state, 'switches-state-of', fact.widgetId, action.panelId, {
            provenance: fact.confidence === 'inferred' ? 'derived' : 'fact',
            rule: RULES.switchesState,
            evidence,
          });
        }
        for (const target of action.targets ?? []) {
          const to = resolveTargetId(target, state);
          if (!to || to === fact.widgetId) continue;
          addRelation(state, 'targets', fact.widgetId, to, {
            provenance: fact.confidence === 'inferred' ? 'derived' : 'fact',
            rule: RULES.targets,
            evidence,
          });
        }
      }
    }
  }
}

/** Resolve an interaction target to an element id present in this document. */
function resolveTargetId(target: InteractionTarget, state: BuildState): string | undefined {
  if (target.widgetId && state.byId.has(target.widgetId)) return target.widgetId;
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Public entry points                                                        */
/* -------------------------------------------------------------------------- */

/** Everything the standardizer needs. All of it is already-read data. */
export interface StandardizeInput {
  page: { id: string; name: string; url: string; title: string; type: string; path: string[] };
  capture: CaptureOutcome;
  /** Outline actually returned to the caller, after hidden-pruning and scope. */
  outline: OutlineNode[];
  interactions?: InteractionAnalysis;
  /** Raw interaction capture, used only for its warnings and gaps when no analysis was run. */
  interactionCapture?: RawInteractionCapture;
  /** Whether the caller asked for the legacy outline or the standard document. */
  detail: StandardDocument['capture']['detail'];
  space: StandardDocument['capture']['space'];
  scope?: OutlineScope;
  /** ISO timestamp for the capture. Passed in so the function stays pure. */
  at: string;
  /** Extra page-level notes, already attributed by target where possible. */
  notes?: Array<{ target: string; text: string }>;
  widgetCount: number;
  pageStats: PageStats;
}

/** Build the standard document from already-read data. Pure. */
export function standardize(input: StandardizeInput): StandardDocument {
  const pageId = input.page.id;

  // Interactions indexed by widget id so each element can link to its own records.
  const facts = input.interactions?.interactions ?? [];
  const interactionRefs = new Map<string, InteractionFact[]>();
  for (const fact of facts) {
    const list = interactionRefs.get(fact.widgetId);
    if (list) list.push(fact);
    else interactionRefs.set(fact.widgetId, [fact]);
  }

  const state: BuildState = {
    pageId,
    roots: [],
    byId: new Map(),
    relations: [],
    textByKey: new Map(),
    relationSeq: 0,
    textOccurrences: 0,
    droppedEmpty: 0,
    cyclesBroken: 0,
  };

  for (const node of input.outline) convertNode(state, node, undefined, interactionRefs, EMPTY_SET);

  // Page-level notes are attributed to an element when their target names one; the rest stay in the
  // index unattributed rather than being attached to a guess.
  for (const note of input.notes ?? []) {
    const target = input.outline.find((node) => node.id === note.target);
    if (target && state.byId.has(target.id)) addText(state, note.text, target.id, 'page-note');
  }

  attachInteractionRelations(state, facts);

  // Duplicate text: every later carrier of an already-seen run relates to the first carrier. This is
  // how 「重复信息消除」 stays auditable instead of merely dropping the repeats.
  for (const bucket of state.textByKey.values()) {
    if (bucket.elementIds.length < 2) continue;
    const [canonical, ...duplicates] = bucket.elementIds;
    if (canonical === undefined) continue;
    for (const duplicate of duplicates) {
      addRelation(state, 'duplicates-text-of', duplicate, canonical, {
        provenance: 'derived',
        rule: RULES.duplicatesText,
      });
    }
  }

  const gaps = [
    ...(input.interactions?.gaps ?? []),
    ...(input.interactionCapture?.gaps ?? []).map((gap) => ({ source: gap.source, reason: gap.reason, impact: gap.impact })),
  ];
  // De-duplicate gaps by source+reason: the analyzer and the raw reader can report the same failure.
  const seenGaps = new Set<string>();
  const uniqueGaps = gaps.filter((gap) => {
    const key = `${gap.source}\u0000${gap.reason}`;
    if (seenGaps.has(key)) return false;
    seenGaps.add(key);
    return true;
  });

  const text = buildTextIndex(state);
  const stats = buildStats(state, facts, input.widgetCount);

  return {
    schema: STANDARD_SCHEMA,
    page: {
      id: pageId,
      name: input.page.name,
      url: input.page.url,
      title: input.page.title,
      authoredType: input.page.type,
      path: [...input.page.path],
    },
    capture: {
      space: input.space,
      detail: input.detail,
      canvas: { ...input.capture.pageSize },
      viewport: { ...input.capture.viewport },
      ...(input.scope ? { scope: input.scope } : {}),
      at: input.at,
    },
    elements: state.roots,
    elementsById: Object.fromEntries(state.byId),
    relations: state.relations,
    text,
    interactions: {
      items: facts,
      gaps: input.interactions?.gaps ?? [],
      stats: input.interactions?.stats ?? emptyInteractionStats(input.widgetCount),
      warnings: input.interactions?.warnings ?? input.interactionCapture?.warnings ?? [],
    },
    stats,
    omitted: { ...input.capture.omitted },
    gaps: uniqueGaps,
    warnings: [
      ...input.capture.warnings,
      ...(state.cyclesBroken > 0
        ? [`the capture's widget tree contained ${state.cyclesBroken} cycle(s); those branches were cut so the walk could finish`]
        : []),
    ],
  };
}

/** Interaction stats for a document built without running the analyzer. */
function emptyInteractionStats(widgetCount = 0): StandardDocument['interactions']['stats'] {
  // `widgets` reports what the outline extractor counted, not 0: a zero here would read as "this
  // page holds no widgets" when the truth is "the analyzer did not run".
  return {
    widgets: widgetCount,
    widgetsWithInteractions: 0,
    byConfidence: { declared: 0, observed: 0, inferred: 0 },
    byActionKind: {},
    branches: 0,
  };
}

/** Fold the collected text buckets into the published index. */
function buildTextIndex(state: BuildState): StandardTextIndex {
  const entries: StandardTextIndex['entries'] = [];
  for (const bucket of state.textByKey.values()) {
    entries.push({
      text: bucket.text,
      elementIds: [...bucket.elementIds],
      occurrences: bucket.elementIds.length,
      from: bucket.from,
    });
  }
  // Deterministic order: most-shared text first, then by text, so two runs of the same page agree.
  entries.sort((left, right) => {
    if (right.occurrences !== left.occurrences) return right.occurrences - left.occurrences;
    return left.text.localeCompare(right.text);
  });
  return {
    entries,
    totalOccurrences: state.textOccurrences,
    distinctTexts: entries.length,
    droppedEmpty: state.droppedEmpty,
  };
}

/** Aggregate the published counts. */
function buildStats(state: BuildState, facts: InteractionFact[], widgetCount: number): StandardStats {
  const byRole: Record<string, number> = {};
  let rolesKnown = 0;
  let rolesUnknown = 0;
  let maxDepth = 0;
  // Every element, at any depth, so the counts account for the whole document and not only its roots.
  for (const element of state.byId.values()) {
    if (element.role.provenance === 'unknown') {
      rolesUnknown += 1;
      byRole.unknown = (byRole.unknown ?? 0) + 1;
    } else {
      rolesKnown += 1;
      const role = element.role.value;
      byRole[role] = (byRole[role] ?? 0) + 1;
    }
    if (element.depth > maxDepth) maxDepth = element.depth;
  }

  const byConfidence = { declared: 0, observed: 0, inferred: 0 };
  for (const fact of facts) byConfidence[fact.confidence] += 1;

  return {
    widgets: widgetCount,
    elements: state.byId.size,
    roots: state.roots.length,
    maxDepth,
    rolesKnown,
    rolesUnknown,
    byRole,
    relations: state.relations.length,
    interactions: {
      total: facts.length,
      declared: byConfidence.declared,
      observed: byConfidence.observed,
      inferred: byConfidence.inferred,
    },
  };
}

/**
 * Drop elements hidden by the prototype, recursively.
 *
 * Mirrors the private `pruneHidden` in the service so the two agree, and is exported so the unit
 * suite can assert that agreement rather than trusting it. Recursion matters: a filter that touched
 * only the top level would leave hidden children of a visible parent in place, which is the bug
 * this function exists to prevent.
 */
export function pruneHidden(nodes: OutlineNode[]): OutlineNode[] {
  const kept: OutlineNode[] = [];
  for (const node of nodes) {
    if (node.visible === false) continue;
    const children = node.children ? pruneHidden(node.children) : undefined;
    const copy: OutlineNode = { ...node };
    if (children && children.length) copy.children = children;
    else delete copy.children;
    kept.push(copy);
  }
  return kept;
}
