/**
 * Standard document (`axure.page/v1`) → text for the model.
 *
 * This is the text sibling of `render.ts` (legacy outline) and `interaction-render.ts`
 * (interaction result), and it keeps both of their rules:
 *
 * 1. **Every prototype-derived value is untrusted data.** Page names, widget names, widget text,
 *    annotations, authored type tokens and URLs are controlled by whoever can publish the project.
 *    A single unescaped newline lets that content forge an extra element line, a `warning:`, or a
 *    whole `## section` in the block a model reads, so every such value goes through
 *    {@link neutralizeUntrusted} on its way into the output and text the renderer itself clips goes
 *    through {@link truncateWellFormed}.
 * 2. **The trust statement comes first.** No escaping makes attacker prose distinguishable from
 *    server prose, so the notice is line one, before any prototype text, on every path through this
 *    module including the hard-capped fallback.
 *
 * ## Why this renderer never prints a role it cannot justify
 *
 * `StandardElement.role` is a `Confidence<StandardRole>`: either a value together with the
 * provenance that produced it, or an explicit `unknown` with a machine-readable reason. Text is
 * exactly where that distinction dies, because prose has no types: a line that says `button` reads
 * as a fact whether a classifier derived it or a renderer guessed it. So every element line carries
 * its own evidence — `<authoredType> > <role> (derived: <rule>)`, or
 * `<authoredType> > unknown(<reason>)` with the word `unknown` printed verbatim and never replaced
 * by a plausible-sounding stand-in. `## unknown` additionally lists every element nobody could
 * classify with its `reason` and `detail`, so "not determined" stays visible instead of looking
 * like "no such element".
 *
 * The same rule shapes the rest of the format: relations print `fact`/`derived`/`declared`/
 * `observed`/`inferred` rather than plain prose, interaction records print their confidence and
 * their source, geometry is labelled as derived, `scopedConnector` elements are marked as outside
 * the requested scope, and clipped text says how long the full run was. A bounded response says it
 * is bounded and says what was dropped, so a reader never mistakes a prefix for the whole page.
 */

import { neutralizeUntrusted, truncateWellFormed } from '../security.js';
import { UNTRUSTED_NOTICE } from './render.js';
import type {
  Confidence,
  InteractionAction,
  InteractionBranch,
  InteractionConfidence,
  InteractionFact,
  InteractionTarget,
  StandardDocument,
  StandardElement,
  StandardRelation,
  StandardRole,
} from '../types.js';

/* -------------------------------------------------------------------------- */
/* Allowances and limits                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-line text allowance for one element's own text.
 *
 * The capture layer may already have clipped a node (`textTruncated`), but the standard document
 * can still carry a multi-kilobyte run, so the renderer clips again and says so.
 */
const TEXT_ALLOWANCE = 120;

/** Per-line allowance for an element's designer annotation. */
const NOTE_ALLOWANCE = 160;

/** Per-line allowance for an image asset URL, which is untrusted and can be very long. */
const URL_ALLOWANCE = 80;

/**
 * How many distinct text entries to list.
 *
 * Bounded because a real page has hundreds; the summary line always states the total distinct
 * count, so this list is never mistaken for the whole index.
 */
const TEXT_ENTRY_LIMIT = 10;

/** How many carriers to name per text entry, before summarising the rest as `+n`. */
const TEXT_CARRIER_LIMIT = 4;

/** How many role buckets to list in the header breakdown. */
const ROLE_BREAKDOWN_LIMIT = 12;

/** How many requested-but-missing widget ids to echo in the scope line. */
const SCOPE_ID_LIMIT = 8;

/**
 * The project's own vocabulary for how much is known, reused verbatim so the text and the
 * structured payload cannot drift apart.
 */
const EVIDENCE_LABEL: Record<InteractionConfidence, string> = {
  declared: 'declared: the project model states it',
  observed: 'observed: the action was triggered and this is what changed',
  inferred: 'inferred: only appearance suggests it, so this record is a guess',
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Quote one untrusted value for single-line placement.
 *
 * Neutralization is what actually prevents line forgery; the JSON quotes are for the reader, so a
 * name with leading spaces or a stray quote cannot be mis-parsed as server syntax.
 */
function q(value: string): string {
  const quoted = JSON.stringify(neutralizeUntrusted(value));
  return quoted === undefined ? '""' : quoted;
}

/** Clamp a caller-supplied budget to a non-negative integer. */
function normalizeBudget(charBudget: number): number {
  if (!Number.isFinite(charBudget)) return 0;
  return Math.max(0, Math.floor(charBudget));
}

/**
 * Cut text to a hard cap on a well-formed boundary.
 *
 * `truncateWellFormed` appends an ellipsis after the cut, so the cut is made one character short:
 * the promise made by `renderStandardWithin` is `length <= budget`, not `budget + 1`.
 */
function hardCap(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return truncateWellFormed(text, Math.max(0, budget - 1));
}

/** `1 relation` / `2 relations`, so a count of one does not read as an unfilled template. */
function count(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

/** One role bucket, count-descending then name-ascending, so two runs agree. */
function roleBreakdown(byRole: Record<string, number>): { entries: Array<[string, number]>; hidden: number } {
  const entries = Object.entries(byRole).sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  });
  return { entries: entries.slice(0, ROLE_BREAKDOWN_LIMIT), hidden: Math.max(0, entries.length - ROLE_BREAKDOWN_LIMIT) };
}

/* -------------------------------------------------------------------------- */
/* Elements                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The role bracket: authored type, the derived role, and the rule that produced it.
 *
 * An unknown role prints the word `unknown` with its reason. There is deliberately no branch that
 * substitutes a likely role when evidence is missing — that branch is the bug this format exists to
 * prevent. The parameter is typed as the full `Confidence<StandardRole>` union rather than as the
 * element, so the narrow branch below is the only way to reach `role.value` at all.
 */
function roleTag(role: Confidence<StandardRole>, authoredType: string): string {
  const type = neutralizeUntrusted(authoredType);
  if (role.provenance === 'unknown') return `${type} > unknown(${role.reason})`;
  const evidence = role.rule ? `${role.provenance}: ${neutralizeUntrusted(role.rule)}` : role.provenance;
  return `${type} > ${role.value} (${evidence})`;
}

/**
 * Triggers recorded for one element, each carrying its confidence.
 *
 * The element line is where a reader decides whether an element is worth a closer look, so it must
 * not present a guess as a fact: an inferred trigger is tagged `(inferred)` right here as well as in
 * the interaction section.
 */
function renderTriggers(facts: readonly InteractionFact[]): string {
  const seen = new Set<string>();
  const rendered: string[] = [];
  for (const fact of facts) {
    const key = `${fact.trigger}\u0000${fact.confidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rendered.push(`${neutralizeUntrusted(fact.trigger)}(${fact.confidence})`);
  }
  return `triggers=${rendered.join(',')}`;
}

/** Render one element as a single indented line. */
function renderElement(element: StandardElement, facts: readonly InteractionFact[] | undefined, depth: number): string {
  // Two spaces of section indent plus two per level, and an arrow on nested lines: the hierarchy is
  // visible at a glance without drawing a tree, which keeps one element on one line.
  const indent = `${'  '.repeat(1 + depth)}${depth > 0 ? '⤷ ' : ''}`;

  const parts: string[] = [];
  if (element.name) parts.push(q(element.name));
  parts.push(neutralizeUntrusted(element.id));
  parts.push(`[${roleTag(element.role, element.authoredType)}]`);
  parts.push(`${element.geometry.width}x${element.geometry.height} @ (${element.geometry.x},${element.geometry.y})`);

  const flags: string[] = [];
  if (!element.geometry.visible) flags.push('hidden');
  if (!element.geometry.onScreen) flags.push('off-canvas');
  const stateCount = element.attributes?.stateCount;
  const activeState = element.attributes?.activeState;
  if (stateCount !== undefined) flags.push(`states=${stateCount}`);
  if (activeState !== undefined) flags.push(`active=${activeState}`);
  if (facts?.length) flags.push(renderTriggers(facts));
  if (flags.length) parts.push(flags.join(', '));

  if (typeof element.text === 'string' && element.text.length > 0) {
    const safe = neutralizeUntrusted(element.text);
    const clippedHere = safe.length > TEXT_ALLOWANCE;
    parts.push(`text=${q(clippedHere ? truncateWellFormed(safe, TEXT_ALLOWANCE) : safe)}`);
    // Requirement of the format: a clipped run must say how long the full run was, so a consumer
    // knows it is reading a prefix and not the widget's whole text.
    const fullLength = element.textTruncated?.length;
    if (fullLength !== undefined || clippedHere) parts.push(`text-clipped(full=${fullLength ?? safe.length})`);
  }
  if (element.note) parts.push(`note=${q(truncateWellFormed(neutralizeUntrusted(element.note), NOTE_ALLOWANCE))}`);
  const image = element.attributes?.image;
  if (image) parts.push(`image=${q(truncateWellFormed(neutralizeUntrusted(image), URL_ALLOWANCE))}`);
  if (element.scopedConnector) {
    // Spelled out rather than reduced to a one-word flag: a scoped ancestor exists only to keep the
    // hierarchy connected to a match, and reading it as part of the requested scope is a real
    // mistake, not a cosmetic one.
    parts.push('{scoped connector: kept only to connect a scoped match upward — NOT part of the requested scope}');
  }

  return `${indent}${parts.join('  ')}`;
}

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

/** Render one relation, with the evidence level that makes it believ, or the rule that derived it. */
function renderRelation(relation: StandardRelation): string {
  const to = relation.to !== undefined ? neutralizeUntrusted(relation.to) : '(target not on this page)';
  const evidence =
    relation.evidence !== undefined
      ? EVIDENCE_LABEL[relation.evidence]
      : relation.provenance === 'fact'
        ? 'fact: the prototype states it'
        : `derived: ${neutralizeUntrusted(relation.rule)}`;
  return `  ${relation.kind}  ${neutralizeUntrusted(relation.from)} -> ${to}  (${evidence})`;
}

/* -------------------------------------------------------------------------- */
/* Interactions                                                               */
/* -------------------------------------------------------------------------- */
/*
 * These formatters intentionally restate the compact shapes from `interaction-render.ts` instead of
 * importing them: that module exports only the whole-response `renderInteractions`, and pulling a
 * second full notice plus a second `# interactions` header into the middle of this document would be
 * worse than the duplication. See the report that accompanies this file: exporting a
 * `renderInteractionSection(result)` there would remove the overlap.
 */

/** Render one interaction target. */
function renderTarget(target: InteractionTarget): string {
  const parts: string[] = [];
  if (target.widgetId) {
    parts.push(`widget ${neutralizeUntrusted(target.widgetId)}`);
    // Only a measured answer is printed; an unresolved target stays unresolved.
    if (target.resolved === false) parts.push('(not present on this page)');
  }
  if (target.pageId) parts.push(`page ${neutralizeUntrusted(target.pageId)}`);
  if (target.pageName) parts.push(q(target.pageName));
  if (!parts.length && target.label) parts.push(q(target.label));
  return parts.join(' ') || 'unresolved target';
}

/**
 * Render one action.
 *
 * The model's own label (`rawType`) is preferred over the normalized kind, matching
 * `interaction-render.ts`; the kind is only a coarse bucket, so it is used as the fallback with its
 * hyphens opened up.
 */
function renderAction(action: InteractionAction): string {
  const label = action.rawType ? neutralizeUntrusted(action.rawType) : action.kind.replace(/-/g, ' ');
  const parts: string[] = [];
  if (action.panelId) parts.push(`widget ${neutralizeUntrusted(action.panelId)}`);
  else if (action.targets?.length) {
    const targets = action.targets.map(renderTarget).filter(Boolean).join(', ');
    if (targets) parts.push(targets);
  }
  if (action.state !== undefined) parts.push(`state=${action.state}`);
  if (action.value !== undefined) parts.push(`value=${q(action.value)}`);
  if (action.delayMs !== undefined) parts.push(`${action.delayMs}ms`);
  return parts.length ? `${label}(${parts.join(' ')})` : label;
}

/** Render one branch as `name if <conditions> -> <actions>`. */
function renderBranch(branch: InteractionBranch): string {
  const parts: string[] = [branch.name ? neutralizeUntrusted(branch.name) : 'case'];
  if (branch.conditions?.length) {
    const conditions = branch.conditions
      .map((condition) => {
        const text = condition.conditionString ?? condition.description;
        if (text) {
          const cleaned = neutralizeUntrusted(text).replace(/^if\s+/i, '');
          if (cleaned) return cleaned;
        }
        const bits = [
          condition.target ? neutralizeUntrusted(condition.target) : undefined,
          condition.operator ? neutralizeUntrusted(condition.operator) : undefined,
          condition.value !== undefined ? q(condition.value) : undefined,
        ].filter(Boolean);
        return bits.join(' ') || 'a condition';
      })
      .filter(Boolean);
    if (conditions.length) parts.push(`if ${conditions.join(' and ')}`);
  }
  parts.push('->');
  parts.push(branch.actions.length ? branch.actions.map(renderAction).join(' ; ') : '(no actions)');
  return parts.join(' ');
}

/**
 * Render one interaction record, multi-line.
 *
 * A record is the atomic unit of budget trimming: its branch lines are never separated from the
 * record they belong to, so a trimmed document can never show an action whose trigger was dropped.
 */
function renderFact(fact: InteractionFact): string {
  const lines: string[] = [];
  const label = fact.widgetLabel ? ` ${q(fact.widgetLabel)}` : '';
  const rawEvent =
    fact.rawTrigger && fact.rawTrigger !== fact.trigger ? `  raw-event=${q(fact.rawTrigger)}` : '';
  lines.push(
    `  [${fact.confidence}, ${neutralizeUntrusted(fact.source)}] ${neutralizeUntrusted(fact.widgetRef)} ` +
      `<${neutralizeUntrusted(fact.trigger)}>${label}${rawEvent}`,
  );

  if (fact.confidence === 'inferred') {
    // An inferred record has no actions by construction; saying "guessed" here is what stops the
    // line being read as a statement about what the widget does.
    lines.push(
      `    guess: the widget only looks interactive — ${neutralizeUntrusted(
        fact.inferredReason ?? 'no reason recorded',
      )}; no action is known`,
    );
  } else {
    const branches = fact.branches ?? [];
    if (!branches.length) lines.push('    (no actions recorded)');
    for (const branch of branches) lines.push(`    ${renderBranch(branch)}`);
  }
  for (const warning of fact.warnings ?? []) lines.push(`    ! ${neutralizeUntrusted(warning)}`);
  return lines.join('\n');
}

/** Confidence order for the section: facts first, guesses last, so a skim never starts on a guess. */
const CONFIDENCE_RANK: Record<InteractionConfidence, number> = { declared: 0, observed: 1, inferred: 2 };

/* -------------------------------------------------------------------------- */
/* Unknown roles, text index, gaps                                            */
/* -------------------------------------------------------------------------- */

/**
 * Render one element whose role is unknown, with the reason and the human-readable detail.
 *
 * Returns `undefined` for a classified element, so the caller can build the section by filtering the
 * document rather than trusting a separate list to stay in sync.
 */
function renderUnknownElement(element: StandardElement): string | undefined {
  const role = element.role;
  if (role.provenance !== 'unknown') return undefined;
  const parts = [`  ${neutralizeUntrusted(element.id)}`];
  if (element.name) parts.push(q(element.name));
  parts.push(`authored-type=${q(element.authoredType)}`);
  parts.push(`reason: ${role.reason}`);
  parts.push(`— ${neutralizeUntrusted(role.detail ?? 'no detail recorded')}`);
  return parts.join('  ');
}

/** Render one text-index entry: the text, how often it occurs, and a bounded list of carriers. */
function renderTextEntry(entry: StandardDocument['text']['entries'][number]): string {
  const shown = entry.elementIds.slice(0, TEXT_CARRIER_LIMIT).map(neutralizeUntrusted);
  const hidden = entry.elementIds.length - shown.length;
  const carriers = [...shown, ...(hidden > 0 ? [`+${hidden} more`] : [])].join(', ');
  return `  ${q(entry.text)} x${entry.occurrences}  from ${entry.from}  (${carriers || 'no carrier recorded'})`;
}

/** Render one source that could not be read. */
function renderGap(gap: StandardDocument['gaps'][number]): string {
  return `  - ${neutralizeUntrusted(gap.source)}: ${neutralizeUntrusted(gap.reason)} — impact: ${neutralizeUntrusted(
    gap.impact,
  )}`;
}

/** The `omitted:` statement. `none` is printed rather than omitted, so "nothing dropped" is visible. */
function omittedText(omitted: Record<string, number>): string {
  const entries = Object.entries(omitted);
  if (!entries.length) return 'none';
  return entries.map(([reason, count]) => `${neutralizeUntrusted(reason)}=${count}`).join(', ');
}

/* -------------------------------------------------------------------------- */
/* Document model: header lines and trimmable sections                        */
/* -------------------------------------------------------------------------- */

/**
 * One droppable region of the document.
 *
 * The budget machinery works on these instead of on a rendered string, because dropping must happen
 * at section and item boundaries: a mid-line cut could break the notice, a code fence or a
 * half-printed element.
 */
interface Block {
  /** Label used in the trim warning, e.g. `elements`. */
  name: string;
  /** Section heading, when the region owns one. */
  heading?: string;
  /** Count line printed before the items; receives how many items survived the budget. */
  summary?: (keptItems: number) => string;
  /** Atomic items, each of which may span several lines. */
  items: string[];
  /** Printed instead of items when the document genuinely has none. */
  empty?: string;
  /** Printed when the budget cut items, so a short list is never read as a complete one. */
  droppedNote?: (dropped: number) => string;
}

/**
 * Header lines in output order, and — because the budget keeps a prefix of the droppable stream —
 * also in drop priority: page identity and the aggregate counts survive longest, the format legend
 * goes first. `warnings` sit above the derived extras because they are server statements about the
 * capture rather than derived detail.
 */
function buildHeaderLines(document: StandardDocument): string[] {
  const lines: string[] = [];
  lines.push(`# page: ${neutralizeUntrusted(document.page.name)}  [${neutralizeUntrusted(document.page.id)}]`);
  lines.push(`url: ${neutralizeUntrusted(document.page.url)}`);
  if (document.page.title && document.page.title !== document.page.name) {
    lines.push(`title: ${neutralizeUntrusted(document.page.title)}`);
  }
  if (document.page.path.length) {
    lines.push(`sitemap: ${document.page.path.map(neutralizeUntrusted).join(' / ')}`);
  }
  lines.push(`authored-type: ${neutralizeUntrusted(document.page.authoredType)}`);
  lines.push(`schema: ${neutralizeUntrusted(document.schema)}`);
  lines.push(
    `canvas: ${document.capture.canvas.width}x${document.capture.canvas.height}   ` +
      `viewport: ${document.capture.viewport.width}x${document.capture.viewport.height} ` +
      `@ (${document.capture.viewport.scrollX},${document.capture.viewport.scrollY})   ` +
      `space: ${document.capture.space}   detail: ${document.capture.detail}`,
  );

  const stats = document.stats;
  lines.push(
    `stats: ${stats.widgets} widgets; ${stats.elements} elements (${stats.roots} roots, depth ${stats.maxDepth}); ` +
      `roles ${stats.rolesKnown} known, ${stats.rolesUnknown} unknown; ${stats.relations} relations; ` +
      `interactions ${stats.interactions.total} total (${stats.interactions.declared} declared, ` +
      `${stats.interactions.observed} observed, ${stats.interactions.inferred} inferred)`,
  );

  for (const warning of document.warnings) lines.push(`warning: ${neutralizeUntrusted(warning)}`);

  const scope = document.capture.scope;
  if (scope) {
    const bits: string[] = [];
    if (scope.region) {
      bits.push(
        `region ${scope.region.x},${scope.region.y} ${scope.region.width}x${scope.region.height} (${document.capture.space} space)`,
      );
    }
    if (scope.widgetIds?.length) bits.push(`${scope.widgetIds.length} widgetIds`);
    if (scope.onScreenOnly) bits.push('onScreenOnly');
    const missing = scope.missingWidgets ?? [];
    if (missing.length) bits.push(`missing widgets: ${missing.slice(0, SCOPE_ID_LIMIT).map(neutralizeUntrusted).join(', ')}`);
    if (bits.length) lines.push(`scope: ${bits.join('; ')}`);
  }

  const roles = roleBreakdown(document.stats.byRole);
  if (roles.entries.length) {
    const rendered = roles.entries
      .map(([role, count]) => `${neutralizeUntrusted(role)}=${count}`)
      .join(' ');
    lines.push(`roles: ${rendered}${roles.hidden > 0 ? ` (+${roles.hidden} more)` : ''}`);
  }

  lines.push(
    'format: <name?> <id> [<authoredType> > <role> (derived: <rule>) | <authoredType> > unknown(<reason>)] ' +
      '<w>x<h> @ (<x>,<y>) [hidden, off-canvas, states=n, active=n, triggers=<trigger>(<confidence>)] ' +
      'text="" note="" image=""; geometry is derived (capture/geometry); a "{scoped connector: ...}" ' +
      'element is outside the requested scope',
  );
  return lines;
}

/** Build every trimmable section of the document, in output order. */
function buildBlocks(document: StandardDocument): Block[] {
  const factsByWidget = new Map<string, InteractionFact[]>();
  for (const fact of document.interactions.items) {
    const list = factsByWidget.get(fact.widgetId);
    if (list) list.push(fact);
    else factsByWidget.set(fact.widgetId, [fact]);
  }

  const blocks: Block[] = [];

  blocks.push({
    name: 'elements',
    heading: '## elements',
    summary: () =>
      `${document.stats.elements} elements in ${count(document.elements.length, 'top-level tree')}; ` +
      'leading spaces show depth and ⤷ marks a nested element',
    items: (() => {
      // `document.elements` holds the roots and the hierarchy lives in `childIds`, so the tree is
      // walked rather than the root list printed: printing only roots showed 1 element of 1119 on a
      // dense page and silently dropped the rest.
      const lines: string[] = [];
      const printed = new Set<string>();
      const walk = (ids: readonly string[], depth: number): void => {
        for (const id of ids) {
          if (printed.has(id)) {
            // The same id reached twice means `childIds` is a graph, not a tree, and following it
            // again would duplicate the subtree without bound (a cycle would never terminate). The
            // repeat is stated instead of followed.
            lines.push(
              `  ${'  '.repeat(depth)}⤷ (element "${neutralizeUntrusted(id)}" already shown above — ` +
                'childIds links back here, so this document is not a tree)',
            );
            continue;
          }
          const element = document.elementsById[id];
          if (!element) {
            // The tree and the index disagreeing is a defect worth surfacing, not hiding.
            lines.push(`  ${'  '.repeat(depth)}⤷ (missing element "${neutralizeUntrusted(id)}" in elementsById)`);
            continue;
          }
          printed.add(id);
          lines.push(renderElement(element, factsByWidget.get(element.id), depth));
          walk(element.childIds ?? [], depth + 1);
        }
      };
      walk(
        document.elements.map((element) => element.id),
        0,
      );

      // An element no `childIds` reaches would otherwise vanish from the one section a reader uses
      // to see the page at all, so the gap is named and counted rather than left implicit.
      const unreachable = Object.keys(document.elementsById).filter((id) => !printed.has(id));
      if (unreachable.length) {
        const shown = unreachable.slice(0, SCOPE_ID_LIMIT).map(neutralizeUntrusted).join(', ');
        lines.push(
          `  … ${count(unreachable.length, 'element')} in elementsById not reachable from any root ` +
            `(childIds is incomplete): ${shown}` +
            `${unreachable.length > SCOPE_ID_LIMIT ? `, +${unreachable.length - SCOPE_ID_LIMIT} more` : ''}`,
        );
      }
      return lines;
    })(),
    empty: '(none: the capture contains no elements)',
    droppedNote: (dropped) => `  … ${count(dropped, 'more element line')} not shown (character budget)`,
  });

  const relationKinds = new Map<string, number>();
  for (const relation of document.relations) {
    relationKinds.set(relation.kind, (relationKinds.get(relation.kind) ?? 0) + 1);
  }
  const relationBreakdown = [...relationKinds.entries()]
    .sort((left, right) => (right[1] !== left[1] ? right[1] - left[1] : left[0].localeCompare(right[0])))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(' ');
  blocks.push({
    name: 'relations',
    heading: '## relations',
    summary: (kept) =>
      `${document.relations.length} relations${kept < document.relations.length ? `, ${kept} shown` : ''}` +
      `${relationBreakdown ? `: ${relationBreakdown}` : ''}`,
    items: document.relations.map(renderRelation),
    empty: '(none: no containment, targeting or shared-text relation was derived)',
    droppedNote: (dropped) => `  … ${count(dropped, 'more relation')} not shown (character budget)`,
  });

  const interactionStats = document.interactions.stats;
  const ordered = [...document.interactions.items].sort(
    (left, right) => CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence],
  );
  const interactionGaps = document.interactions.gaps.length || document.gaps.length;
  blocks.push({
    name: 'interactions',
    heading: '## interactions',
    summary: (kept) =>
      `${document.interactions.items.length} records` +
      `${kept < document.interactions.items.length ? `, ${kept} shown` : ''}: ` +
      `${interactionStats.byConfidence.declared} declared, ${interactionStats.byConfidence.observed} observed, ` +
      `${interactionStats.byConfidence.inferred} inferred. Evidence: declared = the project model states it; ` +
      'observed = the action was triggered and this is what changed (only one branch is covered); ' +
      'inferred = the widget only looks interactive and no action is known.',
    items: ordered.map(renderFact),
    empty: interactionGaps
      ? '(none readable — see the gaps section; this does NOT mean the page has no interactions)'
      : '(none: every source was readable and none declares an interaction on this page)',
    droppedNote: (dropped) => `  … ${count(dropped, 'more interaction record')} not shown (character budget)`,
  });

  const unknownLines: string[] = [];
  const reasonCounts = new Map<string, number>();
  // Every element, not only the roots: an unknown role is usually a leaf, and iterating
  // `document.elements` reported "0 elements have no determinable role" while the stats line above
  // said otherwise — a direct contradiction inside one response.
  for (const element of Object.values(document.elementsById)) {
    const line = renderUnknownElement(element);
    if (line === undefined) continue;
    unknownLines.push(line);
    const role = element.role;
    if (role.provenance === 'unknown') reasonCounts.set(role.reason, (reasonCounts.get(role.reason) ?? 0) + 1);
  }
  const reasons = [...reasonCounts.entries()]
    .sort((left, right) => (right[1] !== left[1] ? right[1] - left[1] : left[0].localeCompare(right[0])))
    .map(([reason, count]) => `${reason} x${count}`)
    .join(', ');
  blocks.push({
    name: 'unknown',
    heading: '## unknown',
    summary: (kept) =>
      `${count(unknownLines.length, 'element')} ${unknownLines.length === 1 ? 'has' : 'have'} no determinable role` +
      `${reasons ? ` (${reasons})` : ''}${kept < unknownLines.length ? `, ${kept} shown` : ''}`,
    items: unknownLines,
    empty: "(none: every element's role was established from structural evidence)",
    droppedNote: (dropped) => `  … ${count(dropped, 'more unclassified element')} not shown (character budget)`,
  });

  const textEntries = document.text.entries.slice(0, TEXT_ENTRY_LIMIT);
  blocks.push({
    name: 'text',
    heading: '## text index',
    summary: (kept) =>
      `${document.text.distinctTexts} distinct texts, ${document.text.totalOccurrences} occurrences; ` +
      `showing ${kept} of ${document.text.distinctTexts}` +
      `${document.text.droppedEmpty > 0 ? `; ${document.text.droppedEmpty} empty runs dropped before indexing` : ''}`,
    items: textEntries.map(renderTextEntry),
    empty: '(none: the page carries no indexable text)',
    droppedNote: (dropped) => `  … ${count(dropped, 'more text entry', 'more text entries')} not shown (character budget)`,
  });

  blocks.push({
    name: 'gaps',
    heading: '## gaps and omissions',
    summary: () => `omitted: ${omittedText(document.omitted)}`,
    items: document.gaps.map(renderGap),
    empty: 'gaps: none (every source that was looked for was read)',
    droppedNote: (dropped) => `  … ${count(dropped, 'more gap')} not shown (character budget)`,
  });

  return blocks;
}

/** How many droppable lines the whole document has, which bounds the budget search. */
function totalDroppable(document: StandardDocument): number {
  let total = buildHeaderLines(document).length;
  for (const block of buildBlocks(document)) {
    total += (block.heading ? 1 : 0) + (block.summary ? 1 : 0) + Math.max(block.items.length, 1);
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/** The statement that the text below is a prefix, listing every region that lost lines. */
function renderTrimWarning(shortfalls: readonly string[], charBudget: number, style: 'full' | 'minimal'): string {
  const detail = shortfalls.join(', ');
  if (style === 'minimal') {
    return `warning: trimmed to the ${charBudget}-character budget — prefix only. Not shown: ${detail}.`;
  }
  return (
    `warning: trimmed to the ${charBudget}-character response budget; this text is a prefix of the capture, ` +
    `not the whole document, and the section counts above describe the whole capture. Not shown: ${detail}. ` +
    'Raise charBudget, or pass region or widgetIds to scope the capture to the part you need.'
  );
}

/**
 * Assemble the document, printing only the first `keep` droppable lines.
 *
 * The droppable stream is: header lines, then each section's heading, summary and items in document
 * order. Cutting a prefix rather than an arbitrary slice keeps whole sections and whole interaction
 * records intact, which is what makes the trim notice meaningful: every region that lost lines is
 * named in it, and a section that was cut says so at its end.
 *
 * `keep` may be `Infinity` for the untrimmed rendering; nothing is then reported as dropped.
 */
function assemble(document: StandardDocument, keep: number, style: 'full' | 'minimal', charBudget: number): string {
  const headerLines = buildHeaderLines(document);
  const blocks = buildBlocks(document);

  const body: string[] = [];
  let remaining = Math.max(0, keep);

  const headerKept = Math.min(remaining, headerLines.length);
  remaining -= headerKept;
  for (let index = 0; index < headerKept; index += 1) {
    const line = headerLines[index];
    if (line !== undefined) body.push(line);
  }

  /**
   * `region <dropped> of <total>` for every region that lost lines, in output order. The counts are
   * dropped-of-total, never kept-of-total, because they are printed under "Not shown:".
   */
  const shortfalls: string[] = [];
  if (headerKept < headerLines.length) {
    shortfalls.push(`header lines ${headerLines.length - headerKept} of ${headerLines.length}`);
  }

  for (const block of blocks) {
    const openingCost = (block.heading ? 1 : 0) + (block.summary ? 1 : 0);
    const itemCount = block.items.length;
    // A section is only worth printing when at least one item line — or its explicit "none" line —
    // follows the heading: a heading with nothing under it reads as "this page has nothing here",
    // which is a different, and false, claim.
    if (remaining < openingCost + 1) {
      if (itemCount > 0) shortfalls.push(`${block.name} ${itemCount} of ${itemCount}`);
      continue;
    }
    remaining -= openingCost;
    const keptItems = itemCount > 0 ? Math.min(remaining, itemCount) : 1;
    remaining -= keptItems;

    if (block.heading) body.push(block.heading);
    // An empty block consumes one line for its "none" statement, but that line is not an item: the
    // summary must not report it as one, or an empty text index would claim to be showing something.
    if (block.summary) body.push(block.summary(itemCount > 0 ? keptItems : 0));
    if (itemCount === 0) {
      if (block.empty) body.push(block.empty);
      continue;
    }
    for (let index = 0; index < keptItems; index += 1) {
      const item = block.items[index];
      if (item !== undefined) body.push(item);
    }
    const dropped = itemCount - keptItems;
    if (dropped > 0) {
      if (block.droppedNote) body.push(block.droppedNote(dropped));
      shortfalls.push(`${block.name} ${dropped} of ${itemCount}`);
    }
  }

  const lines: string[] = [UNTRUSTED_NOTICE, ''];
  if (shortfalls.length) {
    // The trim statement goes directly under the notice rather than at the end: a hard cap can cut
    // the tail, and the one thing that must always survive is the admission that this is incomplete.
    lines.push(renderTrimWarning(shortfalls, charBudget, style), '');
  }
  lines.push(...body);
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Public entry points                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Render the whole standard document as text.
 *
 * Never truncates: every element, relation, interaction and text entry is printed, with each
 * section saying `(none: …)` explicitly when it is empty. Callers that need a hard character cap use
 * {@link renderStandardWithin}.
 */
export function renderStandard(document: StandardDocument): string {
  return assemble(document, Number.POSITIVE_INFINITY, 'full', 0);
}

/**
 * Render the standard document inside a character budget.
 *
 * The returned string is guaranteed to satisfy `length <= charBudget`: trimming happens at line and
 * section boundaries by binary-searching how many droppable lines to keep, never by slicing a
 * rendered string, and the trim notice names every region that lost lines. `structuredContent`
 * carries the untrimmed document, so nothing is lost from the machine-readable side; this cap only
 * bounds the text a model reads.
 *
 * `renderPageMapWithin` in `render.ts` uses the same technique on the legacy outline.
 */
export function renderStandardWithin(document: StandardDocument, charBudget: number): string {
  const budget = normalizeBudget(charBudget);
  if (budget === 0) return '';

  const full = renderStandard(document);
  if (full.length <= budget) return full;

  const total = totalDroppable(document);
  // Two passes: the full warning is preferred because it is the useful one, and the minimal wording
  // is the fallback for a budget too small to hold the full sentence alongside any content.
  for (const style of ['full', 'minimal'] as const) {
    let low = 0;
    let high = total;
    let best: string | null = null;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = assemble(document, mid, style, budget);
      if (candidate.length <= budget) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best !== null) return best;
  }

  // Nothing coherent fits: even the notice plus one warning line is over budget. Keep the notice
  // first so the caller still learns what kind of text this is, and cut it rather than emit a
  // document whose header was silently dropped.
  const lastResort = `${UNTRUSTED_NOTICE}\n\nwarning: the ${budget}-character budget could not hold even the document header, so this is the notice alone.`;
  return hardCap(lastResort, budget);
}
