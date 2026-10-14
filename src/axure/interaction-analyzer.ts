/**
 * Interaction analyzer: raw in-page data → typed facts.
 *
 * This module bridges the browser reader and the pure reasoning module. It owns exactly one
 * decision — **what evidence level each record gets** — and it makes that decision from the
 * source, never from how convincing the data looks.
 *
 * | Input | Level | Why |
 * |---|---|---|
 * | The project model states an event with cases/actions | `declared` | The prototype itself says so |
 * | The page was triggered and we saw what changed | `observed` | True, but only about one branch |
 * | A widget merely looks interactive in the DOM | `inferred` | A guess, and carries no actions |
 *
 * No function here can promote a guess: `inferredInteraction` structurally has no parameter for
 * actions, so an inferred record cannot acquire one by a later edit that forgets the rule.
 */

import type { InteractionFact, InteractionGap, InteractionStats, InteractionTarget } from '../types.js';
import {
  declaredInteraction,
  inferredInteraction,
  isRecord,
  sortInteractions,
  summarize,
  type Raw,
} from './interaction.js';
import type { RawInteractionCapture } from './interaction-runtime.js';

/**
 * DOM reasons that indicate a widget *might* be interactive, mapped to a trigger.
 *
 * These are guesses by construction. Each one becomes an `inferred` fact whose `inferredReason`
 * names the evidence, so a consumer can see the basis and discount it appropriately.
 */
const DOM_REASON_TRIGGERS: ReadonlyArray<readonly [string, InteractionFact['trigger'], string]> = [
  ['css-cursor-pointer', 'click', 'CSS cursor is pointer, which suggests it is meant to be clicked'],
  ['form-element:input', 'text-change', 'the widget renders an <input> element'],
  ['form-element:select', 'selection-change', 'the widget renders a <select> element'],
  ['form-element:textarea', 'text-change', 'the widget renders a <textarea> element'],
  ['contains-form-element', 'text-change', 'the widget contains a form element'],
  ['focusable:tabindex', 'focus', 'the widget is focusable via tabindex'],
];

/** Reason prefixes that are role hints rather than an interaction type. */
const ROLE_PREFIX = 'role:';

/** Outcome of analysing one page's interactions. */
export interface InteractionAnalysis {
  interactions: InteractionFact[];
  stats: InteractionStats;
  gaps: InteractionGap[];
  warnings: string[];
}

/**
 * Analyze one page.
 *
 * @param capture - verbatim data from the in-page reader.
 * @param pageId - resolved page id, used to build `widgetRef` values that join to the outline.
 * @param widgetCount - widget count measured by the outline extractor, for the statistics.
 * @param isWidgetPresent - tells whether a target id exists on this page, so targets can be
 *   marked resolved without inventing a value when the answer is unknown.
 */
export function analyzeInteractions(
  capture: RawInteractionCapture,
  pageId: string,
  widgetCount: number,
  isWidgetPresent?: (widgetId: string) => boolean,
): InteractionAnalysis {
  const warnings = [...(capture.warnings ?? [])];
  const gaps: InteractionGap[] = [];
  const interactions: InteractionFact[] = [];

  const resolve = isWidgetPresent
    ? (widgetId: string): boolean => isWidgetPresent(widgetId)
    : undefined;

  // A target that names a widget is measured; one that names only a page is left unmarked.
  const resolveTargets = (targets: InteractionTarget[] | undefined): InteractionTarget[] | undefined => {
    if (!targets || !resolve) return targets;
    return targets.map((target) =>
      target.widgetId === undefined ? target : { ...target, resolved: resolve(target.widgetId) },
    );
  };

  // ---- declared: read from the project model -------------------------------
  for (const entry of capture.entries ?? []) {
    if (!entry || typeof entry.widgetId !== 'string' || !entry.widgetId) {
      warnings.push('skipped a model entry with no usable widget id');
      continue;
    }
    const interaction = isRecord(entry.interaction) ? entry.interaction : {};

    // Panel hashes the reader resolved to DOM ids, keyed by their exact position in the tree.
    const panelIdsByPosition = new Map<string, string>();
    for (const panel of entry.panelIds ?? []) {
      panelIdsByPosition.set(`${panel.eventName}\u0000${panel.caseIndex}\u0000${panel.actionIndex}`, panel.panelId);
    }

    // Each key under the interaction object is a candidate event name; the value is its cases.
    let foundAny = false;
    for (const [eventName, cases] of Object.entries(interaction)) {
      const fact = declaredInteraction(
        {
          widgetRef: `${pageId}#${entry.widgetId}`,
          widgetId: entry.widgetId,
          ...(entry.widgetName ? { widgetLabel: entry.widgetName } : {}),
          rawTrigger: eventName,
        },
        cases as Raw,
        { ...(resolve ? { resolve } : {}) },
      );

      // A declared event with neither branches nor a recognizable trigger tells us nothing
      // beyond "there is a key here"; report it rather than dress it up as knowledge.
      if (fact.trigger === 'unknown' && !fact.branches?.length) {
        warnings.push(
          `model event "${eventName}" on ${entry.widgetId} was not recognized and had no readable cases; ` +
            'it is preserved in rawTrigger but contributes no actions',
        );
      }

      const branches = fact.branches ?? [];
      for (let caseIndex = 0; caseIndex < branches.length; caseIndex += 1) {
        const branch = branches[caseIndex]!;
        for (let actionIndex = 0; actionIndex < branch.actions.length; actionIndex += 1) {
          const action = branch.actions[actionIndex]!;
          const resolvedTargets = resolveTargets(action.targets);
          if (resolvedTargets) action.targets = resolvedTargets;
          if (action.kind === 'set-panel-state') {
            const panelId = panelIdsByPosition.get(`${eventName}\u0000${caseIndex}\u0000${actionIndex}`);
            if (panelId) action.panelId = panelId;
          }
        }
      }

      interactions.push(fact);
      foundAny = true;
    }

    if (!foundAny) {
      warnings.push(`model entry for ${entry.widgetId} carried no recognizable interaction data`);
    }
  }

  // ---- inferred: DOM appearance only --------------------------------------
  for (const candidate of capture.domCandidates ?? []) {
    if (!candidate || typeof candidate.widgetId !== 'string') continue;
    for (const reason of candidate.reasons ?? []) {
      const rule = DOM_REASON_TRIGGERS.find(([token]) => token === reason);
      if (rule) {
        const [, trigger, explanation] = rule;
        interactions.push(
          inferredInteraction(
            { widgetRef: `${pageId}#${candidate.widgetId}`, widgetId: candidate.widgetId },
            trigger,
            explanation,
          ),
        );
        continue;
      }
      if (reason.startsWith(ROLE_PREFIX)) {
        const role = reason.slice(ROLE_PREFIX.length);
        // A role is a hint about semantics, not about a trigger; report it as an unknown
        // trigger rather than picking a plausible one.
        interactions.push(
          inferredInteraction(
            { widgetRef: `${pageId}#${candidate.widgetId}`, widgetId: candidate.widgetId },
            'unknown',
            `the widget carries ARIA role "${role}", which may indicate interactivity`,
          ),
        );
      }
    }
  }

  for (const gap of capture.gaps ?? []) {
    if (gap && typeof gap.source === 'string') {
      gaps.push({
        source: gap.source,
        reason: String(gap.reason ?? 'no reason given'),
        impact: String(gap.impact ?? 'some interactions may be missing'),
      });
    }
  }

  if (capture.truncated) {
    warnings.push(
      'the model traversal hit its widget or depth limit, so some declared interactions were not read',
    );
  }

  const sorted = sortInteractions(interactions);

  // A declared fact supersedes an inferred guess for the same widget and trigger: if the model
  // says what happens, "this looks clickable" adds nothing and would double-count the widget.
  const declaredKeys = new Set(
    sorted.filter((fact) => fact.confidence === 'declared').map((fact) => `${fact.widgetId}\u0000${fact.trigger}`),
  );
  const deduped = sorted.filter(
    (fact) => fact.confidence !== 'inferred' || !declaredKeys.has(`${fact.widgetId}\u0000${fact.trigger}`),
  );

  return {
    interactions: deduped,
    stats: summarize(deduped, widgetCount),
    gaps,
    warnings,
  };
}
