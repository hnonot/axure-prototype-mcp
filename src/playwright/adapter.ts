/**
 * Playwright adapter — the only module that imports `playwright`.
 *
 * Responsibilities, and nothing else:
 *
 * - own the Chromium process and its idle lifetime;
 * - hand out one **isolated context per capture**, so prototype state (panel states, scroll
 *   position, form input) never leaks from one call into the next;
 * - enforce the navigation boundary on every request, including redirects and subresources,
 *   so a caller cannot turn the server into an SSRF proxy;
 * - bound every individual operation with a timeout, because only `page.goto` used to be
 *   covered and a stuck `frame.evaluate` would hang a tool call until the client gave up;
 * - bound concurrency, so N concurrent requests cannot spawn N Chromium renderers;
 * - expose narrow handles ({@link FrameHandle}, {@link SessionHandle}) so the domain layer
 *   never sees a Playwright type.
 */

import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import type { AxureConfig } from '../config.js';
import { InfrastructureError, messageOf } from '../errors.js';
import type { Logger } from '../logger.js';
import { assertNavigable, permittedHosts } from '../security.js';
import { INPAGE_FACTORY_NAME } from '../axure/inpage.js';

/**
 * The narrow frame surface the domain layer is allowed to use.
 *
 * There is exactly **one** way to run code in the page, and it always uses the same convention:
 * `declaration` must define `INPAGE_FACTORY_NAME` (see `axure/inpage.ts`), which is then called
 * with `arg`. The domain modules `axure/extract-source.ts`, `axure/interaction-runtime.ts`,
 * `axure/sitemap.ts` and the small snippets in `service.ts` all follow it.
 *
 * The convention is deliberately singular. An earlier revision exposed both "evaluate an
 * expression" and "run a named factory", and the sitemap reader silently used the wrong one,
 * producing `ReferenceError: axureExtractOutline is not defined` at run time. One shape, checked
 * by `scripts/test-inpage.mjs`, removes that class of mistake.
 */
export interface FrameHandle {
  /** Compile `declaration` in the frame, call its factory, and return the result. */
  run<T>(declaration: string, arg?: unknown): Promise<T>;
  /** The frame's document title. */
  title(): Promise<string>;
  /** Bounding box of the frame's `<body>` in page coordinates. */
  bodyBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** Raw ARIA snapshot of the frame body, for callers that ask to compare it. */
  ariaSnapshot(): Promise<string>;
}

/** One capture session: an isolated context plus the frames an Axure page exposes. */
export interface SessionHandle {
  /** Frame that renders the current page's widgets. */
  contentFrame(): Promise<FrameHandle>;
  /** Frame that owns the project document model (the share shell). */
  shellFrame(): Promise<FrameHandle>;
  /** Navigate to an absolute URL that has already passed the security check. */
  navigate(url: string): Promise<{ status: number }>;
  /** Resize the viewport, used to render the canvas at 1:1. */
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  /** Screenshot the whole page, optionally clipped to a region in page coordinates. */
  screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<Buffer>;
  /** The page's current URL. */
  url(): string;
  /** Wait for a fixed duration. */
  wait(ms: number): Promise<void>;
  /** Release the context. Idempotent. */
  close(): Promise<void>;
}

const round = (value: number): number => Math.round(value);

/** Bounded-concurrency gate; a rejection here is a clear error, not a silent queue. */
class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.#available = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
    } else {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#available += 1;
    };
  }
}

/** Playwright-backed browser pool and session factory. */
export class PlaywrightAdapter {
  readonly #config: AxureConfig;
  readonly #log: Logger;
  readonly #semaphore: Semaphore;
  #browser: Browser | null = null;
  #launching: Promise<Browser> | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #disposed = false;
  #openSessions = 0;

  constructor(config: AxureConfig, log: Logger, options?: { maxConcurrentSessions?: number }) {
    this.#config = config;
    this.#log = log;
    this.#semaphore = new Semaphore(options?.maxConcurrentSessions ?? 4);
  }

  /** Chromium launch options, including the proxy bypass list. */
  #launchOptions() {
    const bypass = this.#config.noProxy
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
    if (this.#disposed) {
      throw new InfrastructureError('BROWSER_UNAVAILABLE', 'the browser adapter has been shut down');
    }
    if (this.#browser?.isConnected()) return this.#browser;
    if (this.#launching) return this.#launching;

    this.#launching = (async () => {
      this.#log.info('launching chromium');
      try {
        const browser = await chromium.launch(this.#launchOptions());
        browser.on('disconnected', () => {
          this.#log.warn('chromium disconnected');
          if (this.#browser === browser) this.#browser = null;
        });
        this.#browser = browser;
        return browser;
      } catch (error) {
        throw new InfrastructureError(
          'BROWSER_UNAVAILABLE',
          `cannot launch chromium: ${messageOf(error)}`,
          {
            retryable: true,
            hint: 'Run `npx playwright install chromium` in the server directory.',
            cause: error,
          },
        );
      } finally {
        this.#launching = null;
      }
    })();

    return this.#launching;
  }

  /** Wrap a promise so one slow operation cannot hang a whole tool call. */
  async #withTimeout<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new InfrastructureError('OPERATION_TIMEOUT', `${label} did not finish within ${ms} ms`, {
                  retryable: true,
                  hint: 'Raise AXURE_OPERATION_TIMEOUT_MS for a slow prototype, or narrow the request with `region`.',
                }),
              ),
            ms,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Abort requests to hosts outside the boundary, including redirects and subresources. */
  async #installNavigationGuard(context: BrowserContext): Promise<void> {
    const allowed = permittedHosts(this.#config);
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.startsWith('data:') || requestUrl.startsWith('blob:') || requestUrl.startsWith('about:')) {
        await route.continue();
        return;
      }
      let host = '';
      try {
        host = new URL(requestUrl).host.toLowerCase();
      } catch {
        await route.abort('blockedbyclient');
        return;
      }
      if (allowed.includes(host)) {
        await route.continue();
        return;
      }
      this.#log.warn('blocked out-of-boundary request', { host, requestUrl: requestUrl.slice(0, 200) });
      await route.abort('blockedbyclient');
    });
  }

  /**
   * Capture Axure's decoded page model before the page's own scripts consume it.
   *
   * The interaction specification lives in `files/<page>/data.js`, which is minified but passes
   * **real property names** into `$axure.loadCurrentPage(...)`. Intercepting that call yields the
   * fully decoded model, which is far more robust than parsing the obfuscated source.
   *
   * This must run before any page script, so it is installed as an init script. It is read-only:
   * the wrapper stores the argument and delegates, changing nothing about page behaviour.
   *
   * Measured payload (reference deployment, Axure 10):
   * - `model.page.diagram.objects` — the widget tree, nested via `objs`
   * - `model.objectPaths[hash].scriptId` — the bridge to the DOM's `u<N>` ids (1119/1119 exact)
   * - `widget.interactionMap[event].cases[].actions[]`
   */
  async #installModelCapture(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
      const install = (): boolean => {
        const ax = (window as unknown as { $axure?: Record<string, unknown> }).$axure;
        if (!ax || typeof ax.loadCurrentPage !== 'function') return false;
        const target = ax as { loadCurrentPage: ((...args: unknown[]) => unknown) & { __axureMcpHooked?: boolean } };
        if (target.loadCurrentPage.__axureMcpHooked) return true;
        const original = target.loadCurrentPage;
        const wrapped = function (this: unknown, ...args: unknown[]): unknown {
          try {
            (window as unknown as { __axureMcpPageModel?: unknown }).__axureMcpPageModel = args[0];
          } catch {
            /* a failed capture must never break the page */
          }
          return original.apply(this, args);
        };
        wrapped.__axureMcpHooked = true;
        target.loadCurrentPage = wrapped;
        return true;
      };
      if (install()) return;
      // `$axure` may not exist yet; poll briefly rather than relying on a specific load order.
      let attempts = 0;
      const timer = setInterval(() => {
        attempts += 1;
        if (install() || attempts > 400) clearInterval(timer);
      }, 10);
    });
  }

  /** Open one isolated session. Callers must `close()` it. */
  async openSession(): Promise<SessionHandle> {
    const release = await this.#semaphore.acquire();
    let browser: Browser;
    try {
      browser = await this.#acquireBrowser();
    } catch (error) {
      release();
      throw error;
    }

    let context: BrowserContext;
    try {
      context = await browser.newContext({
        viewport: { width: this.#config.viewportWidth, height: this.#config.viewportHeight },
        deviceScaleFactor: this.#config.deviceScaleFactor,
        ignoreHTTPSErrors: true,
        bypassCSP: true,
        extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      });
    } catch (error) {
      release();
      throw new InfrastructureError('BROWSER_UNAVAILABLE', `cannot create a browser context: ${messageOf(error)}`, {
        retryable: true,
        cause: error,
      });
    }

    let page: Page;
    try {
      page = await context.newPage();
    } catch (error) {
      // Without this the context would leak, holding a renderer until the browser dies.
      await context.close().catch(() => undefined);
      release();
      throw new InfrastructureError('BROWSER_UNAVAILABLE', `cannot open a page: ${messageOf(error)}`, {
        retryable: true,
        cause: error,
      });
    }

    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    this.#openSessions += 1;
    page.setDefaultTimeout(this.#config.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(this.#config.navigationTimeoutMs);
    await this.#installNavigationGuard(context);
    await this.#installModelCapture(context);

    const config = this.#config;
    const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
      this.#withTimeout(promise, label, config.operationTimeoutMs);

    const wrapFrame = (frame: Frame): FrameHandle => ({
      run: <T>(declaration: string, arg?: unknown): Promise<T> =>
        withTimeout(
          frame.evaluate(
            ({ declaration: code, value, factoryName }) => {
              // Every name used here must exist in the page: nothing from the adapter's module
              // scope is visible inside this function, which `scripts/test-inpage.mjs` guards.
              // `factoryName` therefore arrives as *payload*, not as an interpolated constant.
              const factory = new Function(`${code}; return ${factoryName};`)() as (input: unknown) => T;
              return factory(value);
            },
            { declaration, value: arg, factoryName: INPAGE_FACTORY_NAME },
          ),
          'in-page script',
        ),
      title: () => withTimeout(frame.title(), 'reading the frame title').catch(() => ''),
      bodyBox: async () => {
        const box = await withTimeout(frame.locator('body').boundingBox(), 'measuring the frame body').catch(() => null);
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      },
      ariaSnapshot: () => withTimeout(frame.locator('body').ariaSnapshot(), 'capturing the ARIA snapshot'),
    });

    const findFrame = async (predicate: (frame: Frame) => Promise<boolean>, what: string): Promise<Frame> => {
      const deadline = Date.now() + config.navigationTimeoutMs;
      for (;;) {
        for (const frame of page.frames()) {
          if (await predicate(frame).catch(() => false)) return frame;
        }
        if (Date.now() > deadline) {
          throw new InfrastructureError('NO_CONTENT_FRAME', `no ${what} was found on the loaded page`, {
            hint: 'The URL must point at an Axure share/publish link.',
          });
        }
        await page.waitForTimeout(250);
      }
    };

    let closed = false;
    const session: SessionHandle = {
      contentFrame: () =>
        findFrame(
          (frame) =>
            frame
              .evaluate(() => document.querySelectorAll('#base [id^="u"]').length > 0)
              .catch(() => false),
          'Axure content frame',
        ).then(wrapFrame),
      shellFrame: () =>
        findFrame(
          (frame) =>
            frame
              .evaluate(() => {
                const ax = (window as unknown as { $axure?: { document?: { sitemap?: unknown } } }).$axure;
                return !!(ax && typeof ax === 'object' && ax.document && ax.document.sitemap);
              })
              .catch(() => false),
          'Axure project document',
        ).then(wrapFrame),
      navigate: async (url) => {
        assertNavigable(config, url);
        try {
          const response = await page.goto(url, { waitUntil: 'load', timeout: config.navigationTimeoutMs });
          return { status: response?.status() ?? 0 };
        } catch (error) {
          throw new InfrastructureError(
            'NAVIGATION_FAILED',
            `cannot open ${url}: ${messageOf(error)}`,
            {
              retryable: true,
              hint: 'Check that the Axure host is reachable from this machine and that no HTTP proxy intercepts it.',
              cause: error,
            },
          );
        }
      },
      setViewportSize: async (size) => {
        await page.setViewportSize(size);
      },
      screenshot: (clip) =>
        withTimeout(
          page.screenshot({
            type: 'png',
            animations: 'disabled',
            caret: 'hide',
            ...(clip
              ? {
                  clip: {
                    x: round(clip.x),
                    y: round(clip.y),
                    width: round(clip.width),
                    height: round(clip.height),
                  },
                }
              : {}),
          }),
          'taking a screenshot',
        ),
      url: () => page.url(),
      wait: (ms) => page.waitForTimeout(ms),
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await context.close();
        } catch (error) {
          this.#log.debug('context close failed', { error: messageOf(error) });
        } finally {
          this.#openSessions -= 1;
          release();
          this.#scheduleIdleClose();
        }
      },
    };
    return session;
  }

  #scheduleIdleClose(): void {
    if (this.#disposed || this.#config.browserIdleMs <= 0) return;
    if (this.#openSessions > 0) return;
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
    this.#log.info('closing chromium', { reason });
    await browser.close().catch((error: unknown) => {
      this.#log.warn('browser close failed', { error: messageOf(error) });
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
