/**
 * Streamable HTTP transport smoke test.
 *
 * Starts the server with `--http`, then talks to `/mcp` with a real MCP client over the
 * Streamable HTTP transport. This proves the server is usable as a normal standalone MCP
 * service and not only as a stdio child of one particular client.
 */

import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number.parseInt(process.env.AXURE_TEST_PORT ?? '34117', 10);
const URL_ = `http://127.0.0.1:${PORT}/mcp`;

const child = spawn(process.execPath, [resolve(root, 'bin/axure-mcp.mjs'), '--http', '--port', String(PORT)], {
  env: {
    ...process.env,
    NO_PROXY: 'axure.example.com,localhost,127.0.0.1',
    AXURE_URL: process.env.AXURE_URL || 'https://axure.example.com/ProjectB',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`  [server] ${d}`));

const deadline = Date.now() + 30_000;
let healthy = false;
while (Date.now() < deadline && !healthy) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    healthy = res.ok;
  } catch {
    await new Promise((r) => setTimeout(r, 400));
  }
}

let exitCode = 1;
try {
  if (!healthy) throw new Error('/health never became ready');
  console.log(`PASS  server is listening on ${URL_}`);

  const client = new Client({ name: 'axure-http-selftest', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL_)));
  console.log('PASS  streamable-http handshake');

  const { tools } = await client.listTools();
  console.log(`PASS  tools/list over http: ${tools.map((t) => t.name).join(', ')}`);

  const pages = await client.callTool({ name: 'axure_list_pages', arguments: { filter: '版本' } });
  const count = pages.structuredContent?.pages?.length ?? 0;
  console.log(count > 0 ? `PASS  tool call over http returned ${count} matching page(s)` : 'FAIL  tool call returned no pages');

  await client.close();
  exitCode = count > 0 ? 0 : 1;
} catch (error) {
  console.log('FAIL ', error instanceof Error ? error.message : String(error));
} finally {
  child.kill();
  setTimeout(() => process.exit(exitCode), 300);
}
