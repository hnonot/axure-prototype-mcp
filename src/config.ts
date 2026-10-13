/**
 * Runtime configuration for the Axure Prototype MCP server.
 *
 * Every value has a sane default so the server can start without arguments, and
 * every value can be overridden with an environment variable so one binary can
 * point at any Axure deployment without code changes.
 */

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Fully resolved server configuration. */
export interface AxureConfig {
  /** Origin of the Axure share/publish site, e.g. `http://axure.example.com`. */
  readonly hostOrigin: string;
  /** Project path segment, e.g. `/ProjectB`. */
  readonly projectPath: string;
  /**
   * Canonical project base URL: `<origin><projectPath>` with no trailing slash.
   * The Axure SPA entry point and every relative page/sitemap URL resolve from here.
   */
  readonly baseUrl: string;
  /** Default page URL (absolute) used when a tool call names no page. */
  readonly defaultPageUrl: string;
  readonly headless: boolean;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly deviceScaleFactor: number;
  readonly navigationTimeoutMs: number;
  /** Extra settle time after `load`, for Axure's own bootstrapping scripts. */
  readonly settleMs: number;
  /** Bytes budget for the markdown outline returned to the model. */
  readonly outlineCharBudget: number;
  /** Hard cap on outline nodes, regardless of the byte budget. */
  readonly maxOutlineNodes: number;
  /** Idle lifetime of the pooled browser before it is closed. */
  readonly browserIdleMs: number;
  /** Comma-separated hosts that must bypass any configured HTTP proxy. */
  readonly noProxy: string;
  /** Directory used when a tool call asks for a screenshot file on disk. */
  readonly screenshotDir: string;
  /** Extra Chromium launch arguments. */
  readonly launchArgs: readonly string[];
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/** Split one absolute Axure URL into origin + project path. */
export function splitAxureUrl(rawUrl: string): { origin: string; projectPath: string } {
  const url = new URL(rawUrl);
  return {
    origin: url.origin,
    projectPath: stripTrailingSlash(url.pathname),
  };
}

/** Read configuration from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AxureConfig {
  const rawBase = env.AXURE_URL?.trim() || 'https://axure.example.com/ProjectB';
  const { origin, projectPath } = splitAxureUrl(rawBase);
  const baseUrl = `${origin}${projectPath}`;

  return {
    hostOrigin: origin,
    projectPath,
    baseUrl,
    defaultPageUrl: `${baseUrl}/`,
    headless: bool(env.AXURE_HEADLESS, true),
    viewportWidth: int(env.AXURE_VIEWPORT_WIDTH, 1440),
    viewportHeight: int(env.AXURE_VIEWPORT_HEIGHT, 900),
    deviceScaleFactor: Number(env.AXURE_DEVICE_SCALE_FACTOR ?? '') || 1,
    navigationTimeoutMs: int(env.AXURE_NAV_TIMEOUT_MS, 60_000),
    settleMs: int(env.AXURE_SETTLE_MS, 4_000),
    outlineCharBudget: int(env.AXURE_OUTLINE_CHAR_BUDGET, 48_000),
    maxOutlineNodes: int(env.AXURE_MAX_OUTLINE_NODES, 1_200),
    browserIdleMs: int(env.AXURE_BROWSER_IDLE_MS, 300_000),
    noProxy: env.AXURE_NO_PROXY?.trim() || 'axure.example.com,localhost,127.0.0.1,::1',
    screenshotDir: env.AXURE_SCREENSHOT_DIR?.trim() || '.axure-mcp/shots',
    launchArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
  };
}

/**
 * Hosts that must never go through a configured HTTP proxy.
 *
 * The Axure deployment is normally on an internal network while the host shell may
 * export `HTTP_PROXY`/`HTTPS_PROXY` for registry access, so this list is applied to
 * the browser context as well as the server's own `fetch` calls.
 */
export function noProxyList(config: AxureConfig): string[] {
  return config.noProxy.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/** True when `url` resolves to the configured Axure deployment. */
export function isSameDeployment(config: AxureConfig, url: string): boolean {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${stripTrailingSlash(parsed.pathname)}`.startsWith(config.baseUrl);
  } catch {
    return false;
  }
}
