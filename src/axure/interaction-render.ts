/**
 * Interaction results → text.
 *
 * Two properties matter here more than formatting:
 *
 * 1. **Confirmed interactions and guesses are never in the same section.** The text has a
 *    `## declared` section and an `## inferred` section, and an inferred line can never show
 *    actions because the data it renders cannot contain any. A reader who skims still cannot
 *    mistake a guess for a fact.
 * 2. **Gaps are stated.** "This page has no interactions" and "the interaction source could not
 *    be read" are different claims, and conflating them would be exactly the kind of
 *    fabrication the iteration forbids.
 *
 * Every prototype-derived value is untrusted data and is neutralized before it reaches the
 * output, as in the page-map renderer.
 */

import { neutralizeUntrusted } from '../security.js';
import { UNTRUSTED_NOTICE } from './render.js';
import type {
  InteractionAction,
  InteractionActionKind,
  InteractionBranch,
  InteractionFact,
  InteractionResult,
  InteractionTarget,
} from '../types.js';

/** Human-readable label per action kind. */
const ACTION_LABELS: Partial<Record<InteractionActionKind, string>> = {
  navigate: 'navigate to page',
  'open-url': 'open URL',
  'set-panel-state': 'set panel state',
  'set-panel-state-back': 'set panel to previous state',
  show: 'show',
  hide: 'hide',
  'toggle-visibility': 'toggle visibility',
  'set-text': 'set text',
  'set-value': 'set value',
  'set-selected': 'set selected',
  'set-checked': 'set checked',
  focus: 'focus',
  'expand-collapse': 'expand/collapse',
  move: 'move',
  rotate: 'rotate',
  'set-opacity': 'set opacity',
  'scroll-to': 'scroll to',
  'fire-event': 'fire event',
  wait: 'wait',
};

/** Render one target. */
function renderTarget(target: InteractionTarget): string {
  const parts: string[] = [];
  if (target.widgetId) {
    parts.push(`widget ${neutralizeUntrusted(target.widgetId)}`);
    // Only a measured answer is printed; an unknown resolution stays unknown.
    if (target.resolved === false) parts.push('(not present on this page)');
  }
  if (target.pageId) parts.push(`page ${neutralizeUntrusted(target.pageId)}`);
  if (target.pageName) parts.push(`"${neutralizeUntrusted(target.pageName)}"`);
  if (!parts.length && target.label) parts.push(`"${neutralizeUntrusted(target.label)}"`);
  return parts.join(' ') || 'unresolved target';
}

/**
 * Render one action.
 *
 * The model's own label (`displayName`) is preferred over the normalized kind when present,
 * because Axure's label is the short human name for the action while the normalized kind is a
 * coarse bucket. `value` carries the assigned operand, so the descriptive sentence is not
 * repeated.
 */
function renderAction(action: InteractionAction): string {
  const rawLabel = action.rawType ? neutralizeUntrusted(action.rawType) : undefined;
  const label = rawLabel ?? ACTION_LABELS[action.kind] ?? 'other';

  const parts: string[] = [];
  // A panel-state action's target is a model hash the page map cannot join on, so the resolved DOM
  // id is the useful one and is reported in preference to the raw hash.
  if (action.panelId) parts.push(`widget ${neutralizeUntrusted(action.panelId)}`);
  else if (action.targets?.length) {
    const rendered = action.targets.map(renderTarget).filter(Boolean).join(', ');
    if (rendered) parts.push(rendered);
  }
  if (action.state !== undefined) parts.push(`state=${action.state}`);  if (action.value !== undefined) parts.push(`value=${JSON.stringify(neutralizeUntrusted(action.value))}`);
  if (action.delayMs !== undefined) parts.push(`${action.delayMs}ms`);
  if (!parts.length) return label;
  return `${label}(${parts.join(' ')})`;
}

/**
 * Render one condition.
 *
 * Axure provides its own plain-language rendering in `conditionString` ("if is selected of This
 * equals false"). That is preferred outright when present, because the structured fields are a
 * partial parse of an expression tree and rendering them alone produced a useless `if ==`. The
 * leading "if " is stripped because the branch renderer supplies it.
 */
function renderCondition(condition: NonNullable<InteractionBranch['conditions']>[number]): string {
  const text = condition.conditionString ?? condition.description;
  if (text) {
    const cleaned = neutralizeUntrusted(text).replace(/^if\s+/i, '');
    if (cleaned) return cleaned;
  }
  const bits = [
    condition.target ? neutralizeUntrusted(condition.target) : undefined,
    condition.operator ? neutralizeUntrusted(condition.operator) : undefined,
    condition.value !== undefined ? JSON.stringify(neutralizeUntrusted(condition.value)) : undefined,
  ].filter(Boolean);
  return bits.join(' ') || 'a condition';
}

/** Render one branch as `name: [conditions] -> actions`. */
function renderBranch(branch: InteractionBranch): string {
  const name = branch.name ? neutralizeUntrusted(branch.name) : 'case';
  const parts: string[] = [name];
  if (branch.conditions?.length) {
    const conditions = branch.conditions.map(renderCondition).filter(Boolean);
    if (conditions.length) parts.push(`if ${conditions.join(' and ')}`);
  }
  parts.push('->');
  parts.push(branch.actions.length ? branch.actions.map(renderAction).join(' ; ') : '(no actions)');
  return parts.join(' ');
}

/** Render the header shared by the interaction response. */
function renderHeader(result: InteractionResult): string[] {
  const lines: string[] = [];
  lines.push(UNTRUSTED_NOTICE);
  lines.push('');
  lines.push(`# interactions: ${neutralizeUntrusted(result.page.name)}  [${neutralizeUntrusted(result.page.id)}]`);
  lines.push(`url: ${neutralizeUntrusted(result.page.url)}`);
  if (result.page.path.length) lines.push(`sitemap: ${result.page.path.map(neutralizeUntrusted).join(' / ')}`);

  const { stats } = result;
  lines.push(
    `stats: ${stats.widgetsWithInteractions} of ${stats.widgets} widgets have interaction information; ` +
      `${stats.byConfidence.declared} declared, ${stats.byConfidence.observed} observed, ` +
      `${stats.byConfidence.inferred} inferred; ${stats.branches} branches`,
  );

  const actionKinds = Object.entries(stats.byActionKind);
  if (actionKinds.length) {
    lines.push(`actions: ${actionKinds.map(([kind, count]) => `${kind}=${count}`).join(' ')}`);
  }

  lines.push(
    'evidence: "declared" = the project model states it. "observed" = the action was actually ' +
      'triggered and this is what changed (only one branch is covered). "inferred" = the widget ' +
      'merely looks interactive; no action is known.',
  );

  if (result.gaps.length) {
    lines.push('');
    lines.push('## gaps (what could not be read)');
    for (const gap of result.gaps) {
      lines.push(
        `- ${neutralizeUntrusted(gap.source)}: ${neutralizeUntrusted(gap.reason)} — impact: ${neutralizeUntrusted(gap.impact)}`,
      );
    }
  }

  for (const warning of result.warnings) {
    lines.push(`warning: ${neutralizeUntrusted(warning)}`);
  }

  return lines;
}

/** Render the full interaction analysis as text. */
export function renderInteractions(result: InteractionResult): string {
  const lines = renderHeader(result);

  const declared = result.interactions.filter((fact) => fact.confidence === 'declared');
  const observed = result.interactions.filter((fact) => fact.confidence === 'observed');
  const inferred = result.interactions.filter((fact) => fact.confidence === 'inferred');

  lines.push('');
  lines.push('## declared interactions (facts from the project model)');
  if (!declared.length) {
    lines.push(
      result.gaps.length
        ? '(none readable — see gaps above; this does NOT mean the page has no interactions)'
        : '(none: the project model was readable and declares no interactions on this page)',
    );
  } else {
    for (const fact of declared) {
      lines.push(`  ${neutralizeUntrusted(fact.widgetRef)} <${fact.trigger}>${renderFactLabel(fact)}`);
      for (const branch of fact.branches ?? []) {
        lines.push(`    ${renderBranch(branch)}`);
      }
    }
  }

  if (observed.length) {
    lines.push('');
    lines.push('## observed interactions (facts, but only the branch that was triggered)');
    for (const fact of observed) {
      lines.push(`  ${neutralizeUntrusted(fact.widgetRef)} <${fact.trigger}>${renderFactLabel(fact)}`);
      for (const branch of fact.branches ?? []) {
        lines.push(`    ${renderBranch(branch)}`);
      }
    }
  }

  lines.push('');
  lines.push('## inferred interactivity (guesses — no actions known)');
  if (!inferred.length) {
    lines.push('(none)');
  } else {
    for (const fact of inferred) {
      lines.push(
        `  ${neutralizeUntrusted(fact.widgetRef)} <${fact.trigger}> — ${neutralizeUntrusted(fact.inferredReason ?? 'no reason recorded')}`,
      );
    }
  }

  return lines.join('\n');
}

/** Render the optional widget label beside a fact. */
function renderFactLabel(fact: InteractionFact): string {
  return fact.widgetLabel ? ` ${JSON.stringify(neutralizeUntrusted(fact.widgetLabel))}` : '';
}
