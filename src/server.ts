/**
 * Axure Prototype MCP server.
 *
 * Two transports are supported from the same code path:
 *
 * - `stdio` (default): the server is spawned as a child process by the MCP client and
 *   speaks JSON-RPC over stdin/stdout. This is what DSH's `dsh-mcp-client` uses, and it
 *   keeps the server completely decoupled from DSH internals.
 * - `http`: a Streamable HTTP endpoint, for clients that prefer to connect to a
 *   long-running service (this is how several agents can share one warm browser).
 *
 * The server never writes to stdout outside the protocol channel, so it stays safe under
 * stdio transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type AxureConfig } from './config.js';
import { BrowserPool, type Logger } from './browser.js';
import { registerTools } from './tools.js';

export const SERVER_NAME = 'axure-prototype';
export const SERVER_VERSION = '0.1.0';

/** stderr logger: stdout belongs to the JSON-RPC channel. */
export const stderrLogger: Logger = (level, message, meta) => {
  if (level === 'debug' && process.env.AXURE_DEBUG !== '1') return;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  process.stderr.write(`[axure-mcp] ${level}: ${message}${suffix}\n`);
};

/** Build a server instance wired to a browser pool (created here unless one is supplied). */
export function createServer(options?: { config?: AxureConfig; log?: Logger; pool?: BrowserPool }): {
  server: McpServer;
  pool: BrowserPool;
  config: AxureConfig;
} {
  const config = options?.config ?? loadConfig();
  const log = options?.log ?? stderrLogger;
  const pool = options?.pool ?? new BrowserPool(config, log);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Axure prototype reader. Call axure_list_pages to discover pages, axure_get_page_map to get one page\'s full ' +
        'structure and geometry, and axure_get_visual for the matching PNG pixels. All tools are read-only.',
    },
  );
  registerTools(server, { config, pool, log });
  return { server, pool, config };
}

/** Run over stdio until the client closes the pipe. */
export async function runStdio(options?: { config?: AxureConfig; log?: Logger }): Promise<void> {
  const log = options?.log ?? stderrLogger;
  const { server, pool, config } = createServer(options);
  log('info', 'starting stdio transport', {
    baseUrl: config.baseUrl,
    headless: config.headless,
    viewport: `${config.viewportWidth}x${config.viewportHeight}`,
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutting down', { reason });
    await server.close().catch(() => undefined);
    await pool.dispose();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // The parent closing stdin is the normal end of a stdio session.
  process.stdin.on('close', () => void shutdown('stdin closed'));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { loadConfig };
export type { AxureConfig };
