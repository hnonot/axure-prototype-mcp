/**
 * Streamable HTTP transport smoke test.
 *
 * Starts the server with `--http`, then talks to `/mcp` with a real MCP client over the
 * Streamable HTTP transport. This proves the server is usable as a normal standalone MCP
 * service and not only as a stdio child of one particular client.
 *
 * It also exercises the authentication gate: binding a non-loopback address without a token
 * must be refused, and a token-protected endpoint must reject an unauthenticated request.
 */

import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number.parseInt(process.env.AXURE_TEST_PORT ?? '34117', 10);
const TOKEN_PORT = PORT + 1;
const BASE_ENV = {
  ...process.env,
  NO_PROXY: 'axure.example.com,localhost,127.0.0.1',
  AXURE_URL: process.env.AXURE_URL || 'https://axure.example.com/ProjectB',
};

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const launch = (args, env) =>
  spawn(process.execPath, [resolve(root, 'bin/axure-mcp.mjs'), ...args], {
    env: { ...BASE_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Run a command to completion and capture stderr, for the refusal cases. */
const runToExit = (args, env) =>
  new Promise((resolvePromise) => {
    const child = launch(args, env);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code) => resolvePromise({ code, stderr }));
    setTimeout(() => child.kill(), 20_000);
  });

const waitForHealth = async (port) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

// --- 1. refusing to publish an unauthenticated endpoint ----------------------
const refused = await runToExit(['--http', '--host', '0.0.0.0', '--port', String(PORT + 2)], {});
check(
  'a non-loopback bind without a token is refused at startup',
  refused.code !== 0 && /AXURE_HTTP_TOKEN/.test(refused.stderr),
  `exit=${refused.code}`,
);

// --- 2. a loopback endpoint works without a token ---------------------------
const child = launch(['--http', '--port', String(PORT)], {});
child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`  [server] ${d}`));

try {
  const healthy = await waitForHealth(PORT);
  if (!healthy) throw new Error('/health never became ready');
  console.log(`PASS  server is listening on http://127.0.0.1:${PORT}/mcp`);

  const client = new Client({ name: 'axure-http-selftest', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(`http://127.0.0.1:${PORT}/mcp`)));
  console.log('PASS  streamable-http handshake');

  const { tools } = await client.listTools();
  check('tools/list over http', tools.length === 3, tools.map((t) => t.name).join(', '));

  const pages = await client.callTool({ name: 'axure_list_pages', arguments: { filter: '版本' } });
  const count = pages.structuredContent?.pages?.length ?? 0;
  check('tool call over http returns matching pages', count > 0, `${count} page(s)`);
  check('the untrusted-content notice is present over http', String(pages.content?.[0]?.text ?? '').startsWith('note:'));
  await client.close();
} catch (error) {
  check('http transport', false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill();
}

// --- 3. a token-protected endpoint rejects an unauthenticated request --------
const TOKEN = 'selftest-token-0123456789';
const secured = launch(['--http', '--port', String(TOKEN_PORT)], { AXURE_HTTP_TOKEN: TOKEN });
secured.stderr.on('data', () => undefined);
try {
  const healthy = await waitForHealth(TOKEN_PORT);
  if (!healthy) throw new Error('secured /health never became ready');
  const unauthorized = await fetch(`http://127.0.0.1:${TOKEN_PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  check('an unauthenticated request is rejected', unauthorized.status === 401, `status ${unauthorized.status}`);

  const authorized = await fetch(`http://127.0.0.1:${TOKEN_PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  check('an authenticated request is served', authorized.ok, `status ${authorized.status}`);
} catch (error) {
  check('token gate', false, error instanceof Error ? error.message : String(error));
} finally {
  secured.kill();
}

console.log(`\n${failures === 0 ? 'all http checks passed' : `${failures} http check(s) failed`}`);
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
