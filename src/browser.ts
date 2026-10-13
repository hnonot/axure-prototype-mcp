/**
 * Lazy, self-healing Playwright browser pool.
 *
 * The server keeps one Chromium process alive between tool calls because browser
 * start-up dominates latency; each capture then gets a fresh isolated context so
 * prototype state (panel states, scroll position, form input) never leaks from one
 * tool call into the next.
 *
 * Every Chromium process is tracked and killed on shutdown, and a crashed or
 * disconnected browser is transparently relaunched on the next call, so a long-lived
 * MCP process cannot wedge itself.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { AxureError } from './errors.js';
import type { AxureConfig } from './config.js';

/** Minimal logger the server injects; stderr only, so stdout stays MCP-clean. */
export interface Logger {
  (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void;
}

export interface BrowserSession {
  page: Page;
  context: BrowserContext;
  /** Release the context. Safe to call more than once. */
  dispose(): Promise<void>;
}

export class BrowserPool {
  readonly #config: AxureConfig;
  readonly #log: Logger;
  #browser: Browser | null = null;
  #launching: Promise<Browser> | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #disposed = false;

  constructor(config: AxureConfig, log: Logger) {
    this.#config = config;
    this.#log = log;
  }

  /** The launch options handed to Chromium, including proxy bypass for internal hosts. */
  #launchOptions() {
    const noProxy = this.#config.noProxy;
    const bypass = noProxy
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (entry.includes('://') ? entry : `*${entry}*`))
      .join(';');
    return {
      headless: this.#config.headless,
      args: [...this.#config.launchArgs, `--proxy-bypass-list=${bypass}`],
      timeout: this.#config.navigationTimeoutMs,
    };
  }

  /** Return a live browser, launching or relaunching as needed. */
  async #acquireBrowser(): Promise<Browser> {
    if (this.#disposed) throw new AxureError('BROWSER_UNAVAILABLE', 'the browser pool has been shut down');
    if (this.#browser?.isConnected()) return this.#browser;
    if (this.#launching) return this.#launching;

    this.#launching = (async () => {
      this.#log('info', 'launching chromium');
      try {
        const browser = await chromium.launch(this.#launchOptions());
        browser.on('disconnected', () => {
          this.#log('warn', 'chromium disconnected');
          if (this.#browser === browser) this.#browser = null;
        });
        this.#browser = browser;
        return browser;
      } catch (error) {
        throw new AxureError(
          'BROWSER_UNAVAILABLE',
          `cannot launch chromium: ${error instanceof Error ? error.message : String(error)}`,
          'run `npx playwright install chromium` in the server directory, or set AXURE_CHROMIUM_CHANNEL to use an installed browser.',
        );
      } finally {
        this.#launching = null;
      }
    })();

    return this.#launching;
  }

  /** Open a fresh isolated context and page for one capture. */
  async openSession(viewport?: { width: number; height: number }): Promise<BrowserSession> {
    const browser = await this.#acquireBrowser();
    const width = viewport?.width ?? this.#config.viewportWidth;
    const height = viewport?.height ?? this.#config.viewportHeight;
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: this.#config.deviceScaleFactor,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    const page = await context.newPage();
    page.setDefaultTimeout(this.#config.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(this.#config.navigationTimeoutMs);

    let disposed = false;
    return {
      page,
      context,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await context.close().catch((error: unknown) => {
          this.#log('debug', 'context close failed', { error: String(error) });
        });
        this.#scheduleIdleClose();
      },
    };
  }

  #scheduleIdleClose(): void {
    if (this.#disposed || this.#config.browserIdleMs <= 0) return;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      void this.closeBrowser('idle timeout');
    }, this.#config.browserIdleMs);
    this.#idleTimer.unref?.();
  }

  /** Close the shared browser if it is running. */
  async closeBrowser(reason: string): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    if (!browser) return;
    this.#log('info', 'closing chromium', { reason });
    await browser.close().catch((error: unknown) => {
      this.#log('debug', 'browser close failed', { error: String(error) });
    });
  }

  /** Terminal shutdown: no further sessions are served. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    await this.closeBrowser('server shutdown');
  }
}
