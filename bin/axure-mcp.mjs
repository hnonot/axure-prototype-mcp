#!/usr/bin/env node
/**
 * Axure Prototype MCP launcher.
 *
 *   node bin/axure-mcp.mjs                      # stdio (default; what DSH uses)
 *   node bin/axure-mcp.mjs --http               # Streamable HTTP on 127.0.0.1:3333
 *   node bin/axure-mcp.mjs --http --host 0.0.0.0   # requires AXURE_HTTP_TOKEN
 *
 * Configuration comes from the environment; run with --help for the full list.
 */

import { createRuntime, runStdio } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { loadProcessEnv } from '../dist/env-file.js';
import { ConfigError, messageOf } from '../dist/errors.js';
import { createLogger } from '../dist/logger.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
};

if (flag('help') || flag('h')) {
  process.stdout.write(
    [
      'axure-prototype-mcp — read an Axure prototype over the Model Context Protocol',
      '',
      'Usage:',
      '  axure-mcp [--http] [--port <n>] [--host <addr>]',
      '',
      'Transport:',
      '  (default)              stdio; the client spawns this process',
      '  --http                 Streamable HTTP at http://127.0.0.1:3333/mcp',
      '  --port <n>             HTTP port, 1..65535 (env AXURE_HTTP_PORT)',
      '  --host <addr>          HTTP bind address (env AXURE_HTTP_HOST). Any non-loopback',
      '                         address requires AXURE_HTTP_TOKEN.',
      '',
      'Environment:',
      '  AXURE_URL                        Axure project share URL. REQUIRED — there is no default,',
      '                                   because a built-in address silently served the wrong',
      '                                   prototype. Also settable in a .env file next to this project.',
      '  AXURE_ENV_FILE                   explicit path to a .env file to read instead of searching',
      '  AXURE_ALLOWED_HOSTS              extra hosts the browser may visit, comma separated',
      '  AXURE_HEADLESS                   true|false (default true)',
      '  AXURE_VIEWPORT_WIDTH             default 1440',
      '  AXURE_VIEWPORT_HEIGHT            default 900',
      '  AXURE_DEVICE_SCALE_FACTOR        1..3, fixed per browser context (default 1)',
      '  AXURE_MAX_CAPTURE_VIEWPORT_WIDTH  default 3840',
      '  AXURE_MAX_CAPTURE_VIEWPORT_HEIGHT default 2160',
      '  AXURE_NAV_TIMEOUT_MS             default 60000',
      '  AXURE_OPERATION_TIMEOUT_MS       per in-page call, default 20000',
      '  AXURE_SETTLE_MS                  extra wait after load, default 4000',
      '  AXURE_OUTLINE_CHAR_BUDGET        response text budget, default 48000',
      '  AXURE_MAX_OUTLINE_NODES          default 1200',
      '  AXURE_MAX_INTERACTION_WIDGETS    cap on model widgets read for interactions, default 400',
      '  AXURE_MAX_WIDGET_IDS             default 40',
      '  AXURE_MAX_PAGES                  default 500',
      '  AXURE_BROWSER_IDLE_MS            close chromium after idle, default 300000',
      '  AXURE_NO_PROXY                   proxy bypass list',
      '  AXURE_SCREENSHOT_DIR             base dir for savePath (default .axure-mcp/shots)',
      '  AXURE_LOG_LEVEL                  debug|info|warn|error (default info)',
      '  AXURE_HTTP_PORT / AXURE_HTTP_HOST / AXURE_HTTP_TOKEN',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

/** Report a configuration problem plainly and exit non-zero. */
function fail(message) {
  process.stderr.write(`[axure-mcp] error: ${message}\n`);
  process.exit(2);
}

/**
 * Load configuration, reading `.env` first.
 *
 * `.env` is loaded implicitly because that is what an operator expects when they edit it — the
 * previous behaviour (never read it, and fall back to a built-in address) is exactly the bug this
 * release fixes. A variable already present in the process environment always wins, so a host or
 * container that sets `AXURE_URL` keeps control.
 */
function loadEnvironment() {
  let merged;
  try {
    merged = loadProcessEnv(process.env);
  } catch (error) {
    // A malformed .env must not be silently ignored: that is the failure mode being fixed.
    fail(`could not read the .env file: ${messageOf(error)}`);
  }
  for (const problem of merged.file.problems) {
    process.stderr.write(`[axure-mcp] warning: .env ${problem}\n`);
  }
  if (merged.file.path) {
    process.stderr.write(
      `[axure-mcp] .env: ${merged.file.path}` +
        (merged.file.overridden.length
          ? ` (already set in the environment, so the file did not apply: ${merged.file.overridden.join(', ')})`
          : '') +
        '\n',
    );
  }
  return merged.env;
}

let config;
try {
  config = loadConfig(loadEnvironment());
} catch (error) {
  fail(messageOf(error));
}

const logger = createLogger(config.logLevel, { server: 'axure-prototype' });

if (flag('http')) {
  const { startHttpTransport } = await import('../dist/http.js');
  const port = Number.parseInt(value('port', process.env.AXURE_HTTP_PORT ?? '3333'), 10);
  const host = value('host', process.env.AXURE_HTTP_HOST ?? '127.0.0.1');
  const token = process.env.AXURE_HTTP_TOKEN;

  const primary = createRuntime({ config, log: logger });
  const started = await startHttpTransport(
    () => createRuntime({ config, log: logger, sharedAdapter: primary.adapter }).server,
    { port, host, token },
    logger,
    () => primary.service.dispose(),
  ).catch((error) => {
    fail(messageOf(error));
  });

  const shutdown = async (reason) => {
    logger.info('shutting down', { reason });
    await started.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error: messageOf(error) });
    void shutdown('uncaughtException');
  });
} else {
  await runStdio({ config, log: logger }).catch((error) => {
    if (error instanceof ConfigError) fail(messageOf(error));
    fail(messageOf(error));
  });
}
