/**
 * Environment configuration for the Axure Prototype MCP server.
 *
 * This module is pure and dependency-free: it turns a `ProcessEnv` into a validated,
 * immutable `AxureConfig`, or throws `ConfigError` with every problem listed at once.
 *
 * Failing at startup is deliberate. A malformed `AXURE_URL` used to surface later as an
 * uncaught `TypeError: Invalid URL` from inside the browser launch path, and an absurd
 * viewport (`AXURE_VIEWPORT_WIDTH=99999999`) was accepted without complaint and handed
 * straight to Playwright. Configuration is the one place where a hard, early, explanatory
 * failure is strictly better than a late, confusing one.
 */

import { ConfigError } from './errors.js';

/** A validated, immutable server configuration. */
export interface AxureConfig {
  /** Origin of the Axure share/publish site, e.g. `http://axure.example.com`. */
  readonly hostOrigin: string;
  /** Project path segment, e.g. `/ProjectB`. */
  readonly projectPath: string;
  /**
   * Canonical project base URL: `<origin><projectPath>` with no trailing slash.
   * Every relative page and sitemap URL resolves from here, and it is the SSRF boundary.
   */
  readonly baseUrl: string;
  /** Default page URL (absolute) used when a call names no page. */
  readonly defaultPageUrl: string;

  readonly headless: boolean;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly deviceScaleFactor: number;
  /** Hard ceiling for the auto-enlarged capture viewport, so canvas fitting cannot explode. */
  readonly maxCaptureViewportWidth: number;
  readonly maxCaptureViewportHeight: number;

  /** Navigation timeout. */
  readonly navigationTimeoutMs: number;
  /** Per-operation timeout applied to every in-page call, independent of navigation. */
  readonly operationTimeoutMs: number;
  /** Extra settle time after `load`, for Axure's own bootstrapping scripts. */
  readonly settleMs: number;

  /** Bytes budget for the markdown outline returned to the model. */
  readonly outlineCharBudget: number;
  /** Hard cap on outline nodes, regardless of the byte budget. */
  readonly maxOutlineNodes: number;
  /** Hard cap on widgets returned by one call. */
  readonly maxWidgetIds: number;
  /** Hard cap on sitemap pages returned by one call. */
  readonly maxPages: number;

  /** Idle lifetime of the pooled browser before it is closed. */
  readonly browserIdleMs: number;

  /** Comma-separated hosts that must bypass any configured HTTP proxy. */
  readonly noProxy: string;
  /** Directory used when a tool call asks for a screenshot file on disk. */
  readonly screenshotDir: string;
  /**
   * Additional hosts the browser is allowed to visit, beyond the deployment origin.
   * Empty by default: the prototype is expected to be self-contained, so any navigation
   * outside its origin is treated as an error rather than silently allowed.
   */
  readonly allowedHosts: readonly string[];

  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly launchArgs: readonly string[];
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Defaults, in one table so the README and the code cannot drift apart. */
export const CONFIG_DEFAULTS = {
  AXURE_URL: 'https://axure.example.com/ProjectB',
  AXURE_HEADLESS: true,
  AXURE_VIEWPORT_WIDTH: 1440,
  AXURE_VIEWPORT_HEIGHT: 900,
  AXURE_DEVICE_SCALE_FACTOR: 1,
  AXURE_MAX_CAPTURE_VIEWPORT_WIDTH: 3840,
  AXURE_MAX_CAPTURE_VIEWPORT_HEIGHT: 2160,
  AXURE_NAV_TIMEOUT_MS: 60_000,
  AXURE_OPERATION_TIMEOUT_MS: 20_000,
  AXURE_SETTLE_MS: 4_000,
  AXURE_OUTLINE_CHAR_BUDGET: 48_000,
  AXURE_MAX_OUTLINE_NODES: 1_200,
  AXURE_MAX_WIDGET_IDS: 40,
  AXURE_MAX_PAGES: 500,
  AXURE_BROWSER_IDLE_MS: 300_000,
  AXURE_NO_PROXY: 'axure.example.com,localhost,127.0.0.1,::1',
  AXURE_SCREENSHOT_DIR: '.axure-mcp/shots',
  AXURE_LOG_LEVEL: 'info',
} as const;

/** Upper bounds, so a typo cannot reach Playwright as an impossible request. */
const LIMITS = {
  viewportWidth: { min: 320, max: 4_000 },
  viewportHeight: { min: 240, max: 4_000 },
  maxCaptureViewportWidth: { min: 320, max: 8_000 },
  maxCaptureViewportHeight: { min: 240, max: 8_000 },
  deviceScaleFactor: { min: 1, max: 3 },
  navigationTimeoutMs: { min: 1_000, max: 600_000 },
  operationTimeoutMs: { min: 500, max: 300_000 },
  settleMs: { min: 0, max: 120_000 },
  outlineCharBudget: { min: 1_000, max: 400_000 },
  maxOutlineNodes: { min: 20, max: 20_000 },
  maxWidgetIds: { min: 1, max: 200 },
  maxPages: { min: 1, max: 5_000 },
  browserIdleMs: { min: 0, max: 86_400_000 },
} as const;

/** Collects problems so the operator sees all of them in one run. */
class ConfigProblems {
  readonly #problems: string[] = [];

  add(name: string, message: string): void {
    this.#problems.push(`${name}: ${message}`);
  }

  get empty(): boolean {
    return this.#problems.length === 0;
  }

  throwIfAny(): void {
    if (this.#problems.length === 0) return;
    throw new ConfigError(
      `invalid configuration (${this.#problems.length} problem${this.#problems.length === 1 ? '' : 's'}):\n  - ` +
        this.#problems.join('\n  - '),
    );
  }
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const readBool = (raw: string | undefined, fallback: boolean, name: string, problems: ConfigProblems): boolean => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  problems.add(name, `expected a boolean (true/false/1/0/yes/no/on/off), got ${JSON.stringify(raw)}`);
  return fallback;
};

const readInt = (
  raw: string | undefined,
  fallback: number,
  name: string,
  bounds: { min: number; max: number },
  problems: ConfigProblems,
): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  const parsed = Number(text);
  if (!Number.isInteger(parsed)) {
    problems.add(name, `expected an integer, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    problems.add(name, `${parsed} is outside the allowed range ${bounds.min}..${bounds.max}`);
    return fallback;
  }
  return parsed;
};

/** Split one absolute Axure URL into origin + project path. */
export function splitAxureUrl(rawUrl: string): { origin: string; projectPath: string } {
  const url = new URL(rawUrl);
  return { origin: url.origin, projectPath: stripTrailingSlash(url.pathname) };
}

/**
 * Read and validate configuration from the environment.
 *
 * @throws ConfigError listing every invalid value, so one run fixes them all.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AxureConfig {
  const problems = new ConfigProblems();

  const rawBase = env.AXURE_URL?.trim() || CONFIG_DEFAULTS.AXURE_URL;
  let origin = '';
  let projectPath = '';
  try {
    const parsed = new URL(rawBase);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.add('AXURE_URL', `expected an http(s) URL, got protocol ${JSON.stringify(parsed.protocol)}`);
    } else if (!parsed.hostname) {
      problems.add('AXURE_URL', 'expected a hostname');
    } else {
      origin = parsed.origin;
      projectPath = stripTrailingSlash(parsed.pathname);
    }
  } catch {
    problems.add('AXURE_URL', `not a valid absolute URL: ${JSON.stringify(rawBase)}`);
  }
  const baseUrl = origin ? `${origin}${projectPath}` : '';

  const config: AxureConfig = {
    hostOrigin: origin,
    projectPath,
    baseUrl,
    defaultPageUrl: baseUrl ? `${baseUrl}/` : '',
    headless: readBool(env.AXURE_HEADLESS, CONFIG_DEFAULTS.AXURE_HEADLESS, 'AXURE_HEADLESS', problems),
    viewportWidth: readInt(env.AXURE_VIEWPORT_WIDTH, CONFIG_DEFAULTS.AXURE_VIEWPORT_WIDTH, 'AXURE_VIEWPORT_WIDTH', LIMITS.viewportWidth, problems),
    viewportHeight: readInt(env.AXURE_VIEWPORT_HEIGHT, CONFIG_DEFAULTS.AXURE_VIEWPORT_HEIGHT, 'AXURE_VIEWPORT_HEIGHT', LIMITS.viewportHeight, problems),
    deviceScaleFactor: readInt(env.AXURE_DEVICE_SCALE_FACTOR, CONFIG_DEFAULTS.AXURE_DEVICE_SCALE_FACTOR, 'AXURE_DEVICE_SCALE_FACTOR', LIMITS.deviceScaleFactor, problems),
    maxCaptureViewportWidth: readInt(env.AXURE_MAX_CAPTURE_VIEWPORT_WIDTH, CONFIG_DEFAULTS.AXURE_MAX_CAPTURE_VIEWPORT_WIDTH, 'AXURE_MAX_CAPTURE_VIEWPORT_WIDTH', LIMITS.maxCaptureViewportWidth, problems),
    maxCaptureViewportHeight: readInt(env.AXURE_MAX_CAPTURE_VIEWPORT_HEIGHT, CONFIG_DEFAULTS.AXURE_MAX_CAPTURE_VIEWPORT_HEIGHT, 'AXURE_MAX_CAPTURE_VIEWPORT_HEIGHT', LIMITS.maxCaptureViewportHeight, problems),
    navigationTimeoutMs: readInt(env.AXURE_NAV_TIMEOUT_MS, CONFIG_DEFAULTS.AXURE_NAV_TIMEOUT_MS, 'AXURE_NAV_TIMEOUT_MS', LIMITS.navigationTimeoutMs, problems),
    operationTimeoutMs: readInt(env.AXURE_OPERATION_TIMEOUT_MS, CONFIG_DEFAULTS.AXURE_OPERATION_TIMEOUT_MS, 'AXURE_OPERATION_TIMEOUT_MS', LIMITS.operationTimeoutMs, problems),
    settleMs: readInt(env.AXURE_SETTLE_MS, CONFIG_DEFAULTS.AXURE_SETTLE_MS, 'AXURE_SETTLE_MS', LIMITS.settleMs, problems),
    outlineCharBudget: readInt(env.AXURE_OUTLINE_CHAR_BUDGET, CONFIG_DEFAULTS.AXURE_OUTLINE_CHAR_BUDGET, 'AXURE_OUTLINE_CHAR_BUDGET', LIMITS.outlineCharBudget, problems),
    maxOutlineNodes: readInt(env.AXURE_MAX_OUTLINE_NODES, CONFIG_DEFAULTS.AXURE_MAX_OUTLINE_NODES, 'AXURE_MAX_OUTLINE_NODES', LIMITS.maxOutlineNodes, problems),
    maxWidgetIds: readInt(env.AXURE_MAX_WIDGET_IDS, CONFIG_DEFAULTS.AXURE_MAX_WIDGET_IDS, 'AXURE_MAX_WIDGET_IDS', LIMITS.maxWidgetIds, problems),
    maxPages: readInt(env.AXURE_MAX_PAGES, CONFIG_DEFAULTS.AXURE_MAX_PAGES, 'AXURE_MAX_PAGES', LIMITS.maxPages, problems),
    browserIdleMs: readInt(env.AXURE_BROWSER_IDLE_MS, CONFIG_DEFAULTS.AXURE_BROWSER_IDLE_MS, 'AXURE_BROWSER_IDLE_MS', LIMITS.browserIdleMs, problems),
    noProxy: env.AXURE_NO_PROXY?.trim() || CONFIG_DEFAULTS.AXURE_NO_PROXY,
    screenshotDir: env.AXURE_SCREENSHOT_DIR?.trim() || CONFIG_DEFAULTS.AXURE_SCREENSHOT_DIR,
    allowedHosts: (env.AXURE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    logLevel: ((): AxureConfig['logLevel'] => {
      const raw = (env.AXURE_LOG_LEVEL ?? '').trim().toLowerCase();
      if (!raw) return CONFIG_DEFAULTS.AXURE_LOG_LEVEL;
      if (!(LOG_LEVELS as readonly string[]).includes(raw)) {
        problems.add('AXURE_LOG_LEVEL', `expected one of ${LOG_LEVELS.join('/')}, got ${JSON.stringify(raw)}`);
        return CONFIG_DEFAULTS.AXURE_LOG_LEVEL;
      }
      return raw as AxureConfig['logLevel'];
    })(),
    launchArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
  };

  if (config.viewportWidth > config.maxCaptureViewportWidth) {
    problems.add(
      'AXURE_VIEWPORT_WIDTH',
      `${config.viewportWidth} exceeds AXURE_MAX_CAPTURE_VIEWPORT_WIDTH (${config.maxCaptureViewportWidth})`,
    );
  }
  if (config.viewportHeight > config.maxCaptureViewportHeight) {
    problems.add(
      'AXURE_VIEWPORT_HEIGHT',
      `${config.viewportHeight} exceeds AXURE_MAX_CAPTURE_VIEWPORT_HEIGHT (${config.maxCaptureViewportHeight})`,
    );
  }

  problems.throwIfAny();
  return Object.freeze(config);
}

/**
 * Hosts that must never go through a configured HTTP proxy.
 *
 * The Axure deployment is normally on an internal network while the host shell may export
 * `HTTP_PROXY`/`HTTPS_PROXY` for registry access. Chromium receives this as
 * `--proxy-bypass-list`, and it is also exposed to the server's own HTTP calls.
 */
export function noProxyList(config: AxureConfig): string[] {
  return config.noProxy
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The hosts the browser is permitted to visit. */
export function allowedHosts(config: AxureConfig): string[] {
  const origin = config.hostOrigin ? new URL(config.hostOrigin).host.toLowerCase() : '';
  return [...new Set([origin, ...config.allowedHosts].filter(Boolean))];
}
