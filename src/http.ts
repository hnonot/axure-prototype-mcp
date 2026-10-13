/**
 * Optional Streamable HTTP transport.
 *
 * DSH connects over stdio, but a server that only speaks stdio cannot be shared by several
 * agents at once or probed with ordinary HTTP tooling. This transport exposes the same tool
 * registry behind `POST /mcp`, so the project also works as a normal standalone MCP service.
 *
 * Safety properties, because this endpoint hands an anonymous caller a browser with internal
 * network access:
 *
 * - it binds to loopback by default;
 * - binding to any other interface **requires** `AXURE_HTTP_TOKEN`, and is refused otherwise,
 *   so the endpoint can never be published unauthenticated by accident;
 * - a request without the matching bearer token is rejected before any tool runs;
 * - it is stateless: every request gets its own protocol instance over a shared browser pool,
 *   so there is no session bookkeeping and a crashed client cannot wedge the endpoint.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConfigError } from './errors.js';
import type { Logger } from './logger.js';

export interface HttpTransportOptions {
  port: number;
  host: string;
  /** Required whenever `host` is not a loopback address. */
  token?: string;
}

/** Hosts that are safe to bind without authentication. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Validate transport options, refusing to publish an unauthenticated endpoint. */
export function validateHttpOptions(options: HttpTransportOptions): void {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new ConfigError(`AXURE_HTTP_PORT/p--port must be an integer between 1 and 65535, got ${options.port}`);
  }
  const host = options.host.trim().toLowerCase();
  if (!host) throw new ConfigError('the HTTP host must not be empty');
  if (!LOOPBACK_HOSTS.has(host) && !options.token) {
    throw new ConfigError(
      `refusing to serve MCP on ${options.host} without authentication.\n` +
        '  - Bind 127.0.0.1 (the default) for local use, or\n' +
        '  - set AXURE_HTTP_TOKEN to a secret value, which every client must then send as `Authorization: Bearer <token>`.\n' +
        '  This endpoint hands callers a Chromium instance with internal network access, so it is never exposed unauthenticated.',
    );
  }
  if (options.token !== undefined && options.token.trim().length < 16) {
    throw new ConfigError('AXURE_HTTP_TOKEN must be at least 16 characters');
  }
}

/** Constant-time-ish comparison; avoids leaking the token length through timing. */
function tokenMatches(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return diff === 0;
}

/** Extract a bearer token from the Authorization header. */
function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Start the HTTP transport and resolve once it is listening. */
export async function startHttpTransport(
  createServerInstance: () => McpServer,
  options: HttpTransportOptions,
  logger: Logger,
  onClose: () => Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  validateHttpOptions(options);
  const expectedToken = options.token?.trim();

  const http = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', server: 'axure-prototype', authenticated: expectedToken !== undefined });
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(response, 404, { error: 'not found; the MCP endpoint is /mcp' });
      return;
    }

    if (expectedToken !== undefined) {
      const provided = bearerToken(request);
      if (!provided || !tokenMatches(expectedToken, provided)) {
        logger.warn('rejected an unauthenticated MCP request', { remote: request.socket.remoteAddress });
        sendJson(response, 401, { error: 'unauthorized: send Authorization: Bearer <AXURE_HTTP_TOKEN>' });
        return;
      }
    }

    // A fresh protocol instance per request keeps the endpoint stateless.
    const server = createServerInstance();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    void server
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch((error: unknown) => {
        logger.error('http request failed', { error: String(error) });
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error handling the MCP request' });
        else response.end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => resolve());
  });

  const url = `http://${options.host}:${options.port}/mcp`;
  logger.info('axure-prototype-mcp ready (streamable-http)', {
    url,
    authenticated: expectedToken !== undefined,
  });

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await onClose();
    },
  };
}
