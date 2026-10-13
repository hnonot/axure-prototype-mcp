/**
 * Optional Streamable HTTP transport.
 *
 * DSH connects over stdio, but an MCP server that only speaks stdio cannot be shared by
 * several agents at once or probed with plain HTTP tooling. This transport exposes the
 * same tool registry behind `POST /mcp` so the project also works as a normal standalone
 * MCP service, which is one of the stated goals for this server.
 *
 * It is stateless: every request gets its own protocol instance over a shared browser
 * pool. A high-level `McpServer` can only be connected to one transport at a time, so a
 * factory is required rather than a single instance. Being stateless means no session
 * bookkeeping, and a crashed client cannot wedge the endpoint.
 */

import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserPool } from './browser.js';
import { stderrLogger } from './server.js';

export interface HttpTransportOptions {
  port: number;
  host: string;
}

/** Builds one protocol instance; the browser pool is shared across all of them. */
export type ServerFactory = (pool: BrowserPool) => McpServer;

/** Start the HTTP transport and resolve once it is listening. */
export async function StartHttpTransport(
  createServerInstance: ServerFactory,
  options: HttpTransportOptions,
  pool: BrowserPool,
): Promise<{ url: string; close: () => Promise<void>; pool: BrowserPool }> {

  const http = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'axure-prototype' }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found; the MCP endpoint is /mcp' }));
      return;
    }

    // A fresh protocol instance per request keeps the endpoint stateless.
    const server = createServerInstance(pool);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((error: unknown) => {
        stderrLogger('error', 'http request failed', { error: String(error) });
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
      });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => resolve());
  });

  const url = `http://${options.host}:${options.port}/mcp`;
  stderrLogger('info', 'axure-prototype-mcp ready (streamable-http)', { url });

  return {
    url,
    pool,
    close: async () => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await pool.dispose();
    },
  };
}
