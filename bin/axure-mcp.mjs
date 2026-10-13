/**
 * Axure Prototype MCP launcher.
 *
 * Supports two transports:
 *
 *   node bin/axure-mcp.mjs                      # stdio (default; used by DSH)
 *   node bin/axure-mcp.mjs --http --port 3333   # Streamable HTTP at /mcp
 *
 * Configuration comes from the environment; see README.md for the full list.
 */

import { runStdio, createServer, loadConfig, stderrLogger } from '../dist/server.js';

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
      'axure-prototype-mcp',
      '',
      'Usage:',
      '  axure-mcp [--http] [--port <n>] [--host <addr>]',
      '',
      'Environment:',
      '  AXURE_URL                  Axure project share URL (default https://axure.example.com/ProjectB)',
      '  AXURE_HEADLESS             true|false (default true)',
      '  AXURE_VIEWPORT_WIDTH       default 1440',
      '  AXURE_VIEWPORT_HEIGHT      default 900',
      '  AXURE_NAV_TIMEOUT_MS       default 60000',
      '  AXURE_SETTLE_MS            extra wait after load, default 4000',
      '  AXURE_MAX_OUTLINE_NODES    default 1200',
      '  AXURE_OUTLINE_CHAR_BUDGET  default 48000',
      '  AXURE_BROWSER_IDLE_MS      close browser after idle, default 300000',
      '  AXURE_NO_PROXY             proxy bypass list, default internal hosts',
      '  AXURE_SCREENSHOT_DIR       default .axure-mcp/shots',
      '  AXURE_DEBUG=1              verbose stderr logging',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const config = loadConfig();

if (flag('http')) {
  const { StartHttpTransport } = await import('../dist/http.js');
  const { BrowserPool } = await import('../dist/browser.js');
  const pool = new BrowserPool(config, stderrLogger);
  const started = await StartHttpTransport(
    (sharedPool) => createServer({ config, pool: sharedPool }).server,
    {
      port: Number.parseInt(value('port', process.env.AXURE_HTTP_PORT ?? '3333'), 10),
      host: value('host', process.env.AXURE_HTTP_HOST ?? '127.0.0.1'),
    },
    pool,
  );
  const shutdown = async (reason) => {
    stderrLogger('info', 'shutting down', { reason });
    await started.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
} else {
  await runStdio({ config });
}
