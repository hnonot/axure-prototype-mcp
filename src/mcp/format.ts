/**
 * Tool result assembly.
 *
 * Every result has the same three parts, which is what makes the server usable from very
 * different clients:
 *
 * 1. a **structured payload** that matches the tool's declared `outputSchema`, so a
 *    programmatic client never has to parse prose;
 * 2. a **text rendering** of that same payload, so a model that only reads text still gets
 *    everything, and so a human reading a transcript can follow along;
 * 3. optionally an **image block**, which the client decides whether to forward.
 *
 * Two properties are enforced here rather than left to callers:
 *
 * - the untrusted-content notice is prepended to every text body, *before* any prototype
 *   text, because no amount of escaping makes attacker-controlled prose distinguishable from
 *   the server's own words;
 * - failures are returned as `isError` results with a stable code in **both** the text and
 *   the structured payload, so a text-only client is not forced to pattern-match.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AxureMcpError, ERROR_CODES, messageOf } from '../errors.js';
import { neutralizeUntrusted } from '../security.js';
import { UNTRUSTED_NOTICE, renderPageMapWithin, renderSitemapResult, renderVisual } from '../axure/render.js';
import { renderInteractions } from '../axure/interaction-render.js';
import type { InteractionResult, PageMapResult, SitemapResult, VisualResult } from '../types.js';

type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; data: string; mimeType: string };

/** Build a successful result from a text body and its structured twin. */
function ok(text: string, structured: Record<string, unknown>, image?: ImageBlock): CallToolResult {
  const content: Array<TextBlock | ImageBlock> = [{ type: 'text', text }];
  if (image) content.push(image);
  return { content, structuredContent: structured };
}

/** Map any thrown value to a stable code. */
function codeOf(error: unknown): string {
  if (error instanceof AxureMcpError) return error.code;
  return 'INTERNAL';
}

/** Read the optional actionable hint a domain or infrastructure error carries. */
function hintOf(error: unknown): string | undefined {
  if (error instanceof AxureMcpError && 'hint' in error) {
    const hint = (error as { hint?: unknown }).hint;
    return typeof hint === 'string' && hint ? hint : undefined;
  }
  return undefined;
}

/**
 * Build a failure result.
 *
 * Note that this is a *protocol-level success* carrying `{ok:false, error:{...}}` next to
 * `isError: true`. That combination is deliberate: `isError` tells the client the call failed,
 * while the structured payload gives a text-only and a schema-driven consumer the same stable
 * code. It is also why the declared `outputSchema` must accept this shape as well as the
 * success shape.
 */
export function errorContent(error: unknown): CallToolResult {
  const code = codeOf(error);
  const retryable = error instanceof AxureMcpError ? error.retryable : false;
  const hint = hintOf(error);
  const message = neutralizeUntrusted(messageOf(error));

  const structured = {
    ok: false as const,
    error: {
      code,
      message,
      ...(hint ? { hint: neutralizeUntrusted(hint) } : {}),
      retryable,
    },
  };

  const lines = [
    UNTRUSTED_NOTICE,
    '',
    `error: ${code}`,
    `message: ${message}`,
    ...(hint ? [`hint: ${neutralizeUntrusted(hint)}`] : []),
    `retryable: ${retryable}`,
    '',
    `known codes: ${ERROR_CODES.join(', ')}`,
  ];

  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }], structuredContent: structured };
}

/** Format the sitemap tool result. */
export function sitemapContent(
  sitemap: SitemapResult,
  options: { filter?: string; truncated: boolean },
): CallToolResult {
  const text = renderSitemapResult(sitemap, options.filter);
  return ok(
    options.truncated
      ? `${text}\n\nwarning: the page list was truncated to AXURE_MAX_PAGES; pass filter to narrow it.`
      : text,
    {
      ok: true,
      projectName: sitemap.projectName,
      baseUrl: sitemap.baseUrl,
      generatedAt: sitemap.generatedAt,
      pageCount: sitemap.pageCount,
      folderCount: sitemap.folderCount,
      filter: options.filter,
      truncated: options.truncated,
      pages: sitemap.pages,
    },
  );
}

/** Format the page-map tool result. */
export function pageMapContent(result: PageMapResult, charBudget: number): CallToolResult {
  const { text, droppedNodes } = renderPageMapWithin(result, charBudget);
  if (droppedNodes > 0) {
    result.warnings.push(
      `${droppedNodes} nodes were dropped from the outline and from this payload to respect the response budget.`,
    );
  }
  const structured = {
    ok: true as const,
    page: result.page,
    space: result.space,
    pageSize: result.pageSize,
    viewport: result.viewport,
    detail: result.detail,
    stats: result.stats,
    omitted: result.omitted,
    outline: result.outline,
    scope: result.scope,
    notes: result.notes,
    accessibility: result.accessibility,
    warnings: result.warnings,
  };
  return ok(text, structured);
}

/** Format the visual tool result, attaching the image only when asked. */
export function visualContent(result: VisualResult): CallToolResult {
  const text = renderVisual(result);
  const attached = result.image !== undefined;
  const structured = {
    ok: true as const,
    page: result.page,
    target: result.target,
    space: result.space,
    canvas: result.canvas,
    viewport: result.viewport,
    region: result.region,
    widgets: result.widgets,
    missingWidgets: result.missingWidgets,
    // The structured payload reports the image's existence and size, never the base64 blob:
    // duplicating megabytes of pixels into `structuredContent` would defeat the purpose of a
    // JSON channel, and a text-only client should not receive it at all.
    image: {
      bytes: result.image?.bytes ?? 0,
      mimeType: 'image/png' as const,
      attached,
    },
    savedTo: result.savedTo,
    warnings: result.warnings,
  };
  return ok(
    text,
    structured,
    attached && result.image
      ? { type: 'image', data: result.image.base64, mimeType: 'image/png' }
      : undefined,
  );
}

/**
 * Format the interaction-analysis result.
 *
 * The text is bounded by the same character budget as the page map, because a dense page can
 * carry as many interactions as widgets. `inferred` records are dropped first when trimming:
 * they are the least informative, and a reader must never lose a fact while keeping a guess.
 */
export function interactionContent(result: InteractionResult, charBudget: number): CallToolResult {
  const { text, droppedInferred } = renderInteractionsWithin(result, charBudget);

  const structured = {
    ok: true as const,
    page: result.page,
    stats: result.stats,
    interactions: result.interactions,
    gaps: result.gaps,
    warnings:
      droppedInferred > 0
        ? [
            ...result.warnings,
            `${droppedInferred} inferred records were omitted from this payload to respect the response budget; ` +
              'the declared facts are all present. Re-run with includeInferred=false to see this deliberately.',
          ]
        : result.warnings,
  };

  return ok(text, structured);
}

/**
 * Render interactions inside a character budget.
 *
 * Trimming order is deliberate and stated in the output: `inferred` guesses go first, and if the
 * budget is still exceeded the remaining records are cut with an explicit count. Facts are never
 * silently dropped while guesses survive.
 */
function renderInteractionsWithin(result: InteractionResult, charBudget: number): { text: string; droppedInferred: number } {
  const full = renderInteractions(result);
  if (full.length <= charBudget) return { text: full, droppedInferred: 0 };

  const inferred = result.interactions.filter((fact) => fact.confidence === 'inferred');
  const factsOnly: InteractionResult = {
    ...result,
    interactions: result.interactions.filter((fact) => fact.confidence !== 'inferred'),
  };
  const trimmed = renderInteractions(factsOnly);
  const note =
    `\n\nwarning: ${inferred.length} inferred records were omitted to stay inside the ` +
    `${charBudget}-character response budget, so the facts above are complete but the guesses are not.`;
  return { text: `${trimmed}${note}`, droppedInferred: inferred.length };
}

