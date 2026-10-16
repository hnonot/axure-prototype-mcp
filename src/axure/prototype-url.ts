/**
 * Caller-supplied prototype addresses: pre-checks, and Axure recognition.
 *
 * ## The trust problem
 *
 * `src/security.ts` guards where the browser may go by comparing against a host allow-list derived
 * from **trusted configuration**. That model assumes the deployment address comes from `.env`, which
 * the operator controls. This module is for the case the iteration adds: the address comes from a
 * **conversation**, so it is attacker-influenceable text — a user can be talked into pasting a URL
 * an adversary chose, and an agent may pass one through from prototype content it read.
 *
 * An allow-list is the wrong instrument there, because the whole point is to reach a host that is not
 * on it. So the address is admitted by **verification** instead of by trust, in two stages:
 *
 * 1. {@link preflightPrototypeUrl} — cheap, purely syntactic, and it runs *before* Chromium is
 *    involved. It rejects the schemes and the specific destinations that make an SSRF useful
 *    (`file:`, cloud instance-metadata endpoints, unusual ports) and normalizes the rest.
 * 2. Axure recognition, run through the real browser — see {@link AXURE_URL_PROBE}. A host that does
 *    not actually serve an Axure prototype is refused, which is what satisfies
 *    「当访问的地址不具有 Axure 的特征…进行限制」: the check is positive evidence, not a heuristic.
 *
 * ## What is deliberately *not* blocked
 *
 * Private and internal ranges. This tool's entire purpose is reading internal prototypes — the
 * reference deployment is `http://axure.example.com/...` — so rejecting RFC1918 addresses would reject the
 * legitimate case while adding little: the operator already chose to expose this server to the
 * prototype network, and stage 2 means an internal host must still *be* an Axure deployment. The one
 * private-ish destination that is always refused is the link-local metadata endpoint, because
 * nothing legitimate lives there.
 */

/** Cloud instance-metadata addresses. Always refused. */
const METADATA_HOSTS = new Set([
  '169.254.169.254', // AWS / Azure / GCP / OpenStack
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud
  'metadata.google.internal',
  'metadata.goog',
]);

/**
 * Ports that are never an Axure share site and are commonly used to attack internal services.
 *
 * Only well-known service ports are listed. Arbitrary high ports are *not* blocked, because an
 * internal Axure deployment on an unusual port is exactly what this feature is for; stage 2 still has
 * to confirm the host serves a prototype.
 */
const BLOCKED_PORTS = new Set([22, 23, 25, 110, 143, 445, 1433, 1521, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017]);

/** Why a caller-supplied address was refused before any navigation. */
export type UrlRejection =
  | 'not-a-url'
  | 'unsupported-scheme'
  | 'metadata-endpoint'
  | 'blocked-port'
  | 'credentials-in-url'
  | 'missing-host';

/** Result of the syntactic pre-check. */
export type PrelightResult =
  | { ok: true; /** Normalized absolute URL. */ url: string; origin: string; host: string; protocol: 'http:' | 'https:' }
  | { ok: false; reason: UrlRejection; detail: string; hint?: string };

/**
 * Validate a caller-supplied prototype address before Chromium sees it.
 *
 * Pure and synchronous, so it is testable without a browser and cheap enough to run on every call.
 */
export function preflightPrototypeUrl(value: string): PrelightResult {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return { ok: false, reason: 'not-a-url', detail: 'the address is empty' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: 'not-a-url',
      detail: `not a valid absolute URL: ${JSON.stringify(trimmed.slice(0, 200))}`,
      hint: 'Pass a full URL including the scheme, e.g. https://axure.example.com/MyProject.',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'unsupported-scheme',
      detail: `only http and https are supported, got ${JSON.stringify(parsed.protocol)}`,
      hint: 'A prototype is served over http(s); file:, ftp: and data: are refused so this server cannot be used to read local files.',
    };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: 'missing-host', detail: 'the URL has no hostname' };
  }

  // Credentials are dropped by nothing here, and a URL carrying them would be forwarded to the host
  // and could leak into logs. Refuse rather than silently strip.
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: 'credentials-in-url',
      detail: 'the URL embeds a username or password',
      hint: 'Configure authentication outside the URL; this server does not forward credentials.',
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (METADATA_HOSTS.has(host)) {
    return {
      ok: false,
      reason: 'metadata-endpoint',
      detail: `${host} is a cloud instance-metadata address`,
      hint: 'Metadata endpoints are never a prototype and are refused unconditionally.',
    };
  }

  const port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) {
    return {
      ok: false,
      reason: 'blocked-port',
      detail: `port ${port} is not an Axure share port`,
      hint: 'Only web ports are reachable. An internal deployment on a non-standard *high* port is allowed.',
    };
  }

  // Normalize: drop a trailing slash on the path, keep any deeper path as the project root.
  const path = parsed.pathname.replace(/\/+$/, '');
  const url = `${parsed.origin}${path}${parsed.search}`;

  return { ok: true, url, origin: parsed.origin, host: parsed.host.toLowerCase(), protocol: parsed.protocol };
}

/**
 * The in-page probe that decides whether a page really is an Axure prototype.
 *
 * Run against every frame, because an Axure share link puts the runtime in an outer shell and the
 * widgets in a content frame. The signals are the ones the reader already depends on, which makes
 * this a check of the same fact the rest of the server needs rather than a separate guess:
 *
 * - `window.$axure` exists — the Axure runtime itself. This is the decisive signal.
 * - `#base` exists — the widget canvas container every Axure page renders.
 * - a `data.js` reference — the per-page model file Axure generates.
 *
 * `axureExtractOutline` is the naming convention the adapter compiles in-page code with; it is
 * declared even though this probe does not call it, so the adapter's single convention holds.
 */
export const AXURE_URL_PROBE = `function axureExtractOutline() {
  const signals = [];

  const runtime = typeof window.$axure !== 'undefined' && window.$axure !== null;
  if (runtime) {
    const kind = typeof window.$axure;
    // A share link exposes the runtime as a function; a prototype export exposes an object. Both
    // are Axure, so the check is presence plus a plausible type, not one exact shape.
    if (kind === 'function' || kind === 'object') signals.push('axure-runtime:' + kind);
  }

  let base = null;
  try {
    base = document.getElementById('base');
  } catch (error) {
    base = null;
  }
  if (base) {
    signals.push('base-canvas');
    // Widgets are addressed as u<number> inside #base; a non-Axure page could still have a #base, so
    // this is a supporting signal rather than a decisive one.
    try {
      if (base.querySelector('[id^="u"]')) signals.push('widget-canvas');
    } catch (error) {
      /* ignore */
    }
  }

  let scripts = [];
  try {
    scripts = Array.prototype.slice.call(document.scripts || []);
  } catch (error) {
    scripts = [];
  }
  const sources = [];
  for (let index = 0; index < scripts.length; index += 1) {
    const src = scripts[index] && scripts[index].src;
    if (typeof src === 'string' && src) sources.push(src);
  }
  let hasDataJs = false;
  let hasAxureRuntime = false;
  for (let index = 0; index < sources.length; index += 1) {
    // Plain substring tests on purpose. This entire probe is a template literal in TypeScript, so a
    // regular expression here has to survive *two* layers of escaping, and getting that wrong is
    // silent in review but fatal in the page: a doubled backslash reached Chromium as a literal
    // backslash and turned the escape into an invalid flag, so every frame failed its probe and no
    // address could ever be verified. Substring checks cannot suffer from that.
    if (sources[index].indexOf('/data.js') !== -1) hasDataJs = true;
    const lowered = sources[index].toLowerCase();
    if (lowered.indexOf('axure.runtime') !== -1 || lowered.indexOf('axure-runtime') !== -1 || lowered.indexOf('axure_standard') !== -1 || lowered.indexOf('axure-standard') !== -1) {
      hasAxureRuntime = true;
    }
  }
  if (hasDataJs) signals.push('data-js');
  if (hasAxureRuntime) signals.push('axure-runtime-script');

  let title = '';
  try {
    title = document.title || '';
  } catch (error) {
    title = '';
  }

  return {
    signals: signals,
    url: location.href,
    title: title,
    scriptCount: sources.length,
    hasRuntime: runtime,
    hasBase: !!base,
  };
}`;

/** Signals one frame reported. */
export interface PrototypeProbeResult {
  signals: string[];
  url: string;
  title: string;
  scriptCount: number;
  hasRuntime: boolean;
  hasBase: boolean;
}

/** The verdict on whether an address serves an Axure prototype. */
export interface PrototypeRecognition {
  ok: boolean;
  /** Signals found, across all frames. */
  signals: string[];
  /** Frames that were inspected. */
  frames: number;
  /** Plain-language reason when `ok` is false. */
  detail?: string;
  /** The page title, for the operator's benefit. */
  title?: string;
}

/**
 * Decide whether the collected frame probes are an Axure prototype.
 *
 * A positive result requires the decisive signal — the Axure runtime — in *some* frame. The other
 * signals are recorded because they explain the answer, but none of them can carry it alone: a page
 * can have a `#base` div or a `data.js` without being an Axure publication, and admitting those on
 * their own would make the check meaningless.
 */
export function recognizePrototype(probes: readonly PrototypeProbeResult[]): PrototypeRecognition {
  const signals = new Set<string>();
  let title: string | undefined;
  let sawRuntime = false;

  for (const probe of probes ?? []) {
    if (!probe) continue;
    for (const signal of probe.signals ?? []) signals.add(signal);
    if (probe.hasRuntime) {
      sawRuntime = true;
      signals.add('axure-runtime');
    }
    if (!title && probe.title) title = probe.title;
  }

  const frames = probes?.length ?? 0;
  if (sawRuntime) {
    return { ok: true, signals: [...signals].sort(), frames, title };
  }

  const supporting = [...signals].filter((signal) => signal !== 'axure-runtime');
  return {
    ok: false,
    signals: supporting.sort(),
    frames,
    title,
    detail:
      `no Axure runtime was found in any of the ${frames} frame(s) inspected` +
      (supporting.length
        ? `; the page had ${supporting.join(', ')}, which is not sufficient on its own`
        : ' and the page had none of the expected Axure structures'),
  };
}
