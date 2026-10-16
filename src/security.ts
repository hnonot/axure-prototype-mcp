/**
 * Trust boundaries.
 *
 * This module is the single place that answers two questions:
 *
 * 1. **Where may the browser go?** The prototype is an internal deployment; a tool caller
 *    is an AI agent that can be steered by content it reads. If caller-supplied input can
 *    reach `page.goto` unvalidated, the server becomes an SSRF proxy with an
 *    internet-reachable API and internal network access. Every candidate target therefore
 *    passes through {@link assertNavigable} before Chromium sees it.
 *
 * 2. **What may be written to disk?** `savePath` used to accept an absolute path or a
 *    `..` traversal and would `mkdir -p` and `writeFile` anywhere the service account could
 *    write. {@link resolveWithinBase} is the only writer of a caller-influenced path.
 *
 * The third concern — that prototype text is untrusted *data*, never instructions — is a
 * property of the output format and is handled in `render/page-map.ts` and
 * `mcp/format.ts`, with {@link neutralizeUntrusted} providing the escaping primitives.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import { DomainError } from './errors.js';

/** The subset of configuration this module needs. */
export interface NavigationBoundary {
  /** Canonical deployment URL; the only origin allowed by default. */
  readonly baseUrl: string;
  /** Additional hosts explicitly permitted by the operator. */
  readonly allowedHosts: readonly string[];
  /**
   * Hosts admitted at runtime by **verification** rather than by configuration.
   *
   * Set when a caller supplies its own prototype address and that address was confirmed to serve a
   * real Axure prototype. Kept separate from `allowedHosts` so the two trust bases stay
   * distinguishable in logs and in reasoning: one is operator policy, the other is evidence.
   */
  readonly verifiedHosts?: readonly string[];
}

/** Parse `host` entries, tolerating a scheme and a port. */
function normalizeHostEntry(entry: string): string {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).host.toLowerCase();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/** Every host the browser is permitted to visit. */
export function permittedHosts(boundary: NavigationBoundary): string[] {
  const hosts: string[] = [];
  if (boundary.baseUrl) {
    try {
      hosts.push(new URL(boundary.baseUrl).host.toLowerCase());
    } catch {
      /* configuration validation already rejected this */
    }
  }
  for (const entry of boundary.allowedHosts) {
    const host = normalizeHostEntry(entry);
    if (host) hosts.push(host);
  }
  for (const entry of boundary.verifiedHosts ?? []) {
    const host = normalizeHostEntry(entry);
    if (host) hosts.push(host);
  }
  return [...new Set(hosts)];
}

/** True when `url` points at a permitted host and uses a permitted scheme. */
export function isNavigable(boundary: NavigationBoundary, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return permittedHosts(boundary).includes(parsed.host.toLowerCase());
}

/**
 * Resolve one caller-supplied page selector against the deployment base URL.
 *
 * Deliberately stricter than `new URL(value, base)`, which is not a containment check:
 *
 * - `new URL('//evil.example/x', base)` **replaces the origin**, so a scheme-relative value
 *   escapes without ever containing `http://`.
 * - `new URL('file:///etc/passwd', base)` ignores the base entirely for an absolute
 *   `file:` URL, so it reaches the navigation sink as a local-file read.
 * - `new URL('../../other-app/x', base)` walks out of the project path while staying on
 *   the host.
 *
 * @returns the absolute URL, or `undefined` when the value is not a safe page reference.
 */
export function resolvePageReference(boundary: NavigationBoundary, value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!boundary.baseUrl) return undefined;

  // Reject any explicit scheme outright; only the deployment's own scheme is implied.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return isNavigable(boundary, trimmed) ? trimmed : undefined;
  }

  // A scheme-relative value would swap the origin.
  if (trimmed.startsWith('//') || trimmed.startsWith('\\\\')) return undefined;

  let candidate: URL;
  try {
    candidate = new URL(trimmed.replace(/^\/+/, ''), `${boundary.baseUrl}/`);
  } catch {
    return undefined;
  }

  // `..` segments must not climb out of the project path.
  const projectPath = new URL(boundary.baseUrl).pathname.replace(/\/+$/, '');
  if (projectPath && !candidate.pathname.startsWith(`${projectPath}/`) && candidate.pathname !== projectPath) {
    return undefined;
  }

  return isNavigable(boundary, candidate.toString()) ? candidate.toString() : undefined;
}

/**
 * Assert that a URL derived from trusted configuration may be navigated to.
 *
 * @throws DomainError NAVIGATION_BLOCKED when the host is outside the boundary.
 */
export function assertNavigable(boundary: NavigationBoundary, url: string): void {
  if (isNavigable(boundary, url)) return;
  const hosts = permittedHosts(boundary);
  let detail = url;
  try {
    detail = new URL(url).host;
  } catch {
    /* keep the raw value in the message */
  }
  throw new DomainError('NAVIGATION_BLOCKED', `navigation to ${detail} is outside the configured Axure deployment`, {
    hint:
      `Only these hosts are reachable: ${hosts.join(', ') || '(none configured)'}. ` +
      'Add a host to AXURE_ALLOWED_HOSTS if the prototype legitimately embeds another origin.',
  });
}

/**
 * Resolve a caller-supplied output path inside a base directory.
 *
 * @throws DomainError WRITE_FAILED when the result would leave the base directory.
 */
export function resolveWithinBase(baseDir: string, requested: string): string {
  const base = resolve(baseDir);
  const target = isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
  const relativePath = relative(base, target);
  const escapes = relativePath.startsWith('..') || isAbsolute(relativePath);
  if (escapes) {
    throw new DomainError('WRITE_FAILED', `savePath must stay inside ${base}`, {
      hint:
        'Pass a relative path such as "page.png", or set AXURE_SCREENSHOT_DIR to the directory you want to write into ' +
        '(and restart the server).',
    });
  }
  return target;
}

/** Control characters, including the C1 range, that would corrupt a text line. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Neutralize untrusted text for single-line placement in the response.
 *
 * Prototype text is attacker-influenceable: anyone who can publish to the Axure project
 * controls it. Collapsing whitespace and dropping control characters prevents that text
 * from forging extra lines (a `format:` line, a `warning:`, a new outline node) in the
 * block the model reads.
 */
export function neutralizeUntrusted(value: string): string {
  return value
    .toWellFormed()
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate to a character budget on a well-formed boundary.
 *
 * `slice` can split a surrogate pair, producing a lone surrogate that serializes to an
 * invalid JSON escape and breaks strict clients, so the result is repaired.
 */
export function truncateWellFormed(value: string, budget: number): string {
  if (value.length <= budget) return value.toWellFormed();
  return `${value.slice(0, budget).toWellFormed()}…`;
}

/**
 * Make text safe to place inside a Markdown code fence.
 *
 * A single backtick sequence embedded in the snapshot would otherwise close the fence and let
 * the rest of the content be read as document structure. Individual backticks are replaced
 * rather than only triple runs, so no line can form a fence.
 */
export function fenceSafe(value: string): string {
  return value.toWellFormed().replace(/`/g, "'");
}
