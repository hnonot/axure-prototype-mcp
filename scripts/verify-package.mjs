/**
 * Verify a PUBLISHED tarball behaves as an MCP server, not just that it installs.
 *
 * The 0.2.3 iteration publishes this package to npm, so the artefact under test is the tarball, not
 * the checkout: `files`, `bin` and the dependency list all decide whether `npx` can start it. This
 * script installs nothing — it is pointed at an already-installed package — and drives the real MCP
 * handshake over stdio, which is the only check that proves a stranger can actually use the package.
 *
 * Run: node scripts/verify-package.mjs <path-to-installed-package-dir>
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const packageDir = resolve(process.argv[2] ?? '');
if (!packageDir || !existsSync(join(packageDir, 'package.json'))) {
  console.error('usage: node scripts/verify-package.mjs <installed-package-dir>');
  process.exit(2);
}

const pkg = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(join(packageDir, 'package.json'), 'utf8')));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** Every path a consumer needs in order to start the server. */
const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[pkg.name];
check('the package declares a bin entry', typeof binEntry === 'string' && binEntry.length > 0, binEntry ?? '(missing)');
check(
  'the bin file ships inside the package',
  typeof binEntry === 'string' && existsSync(join(packageDir, binEntry)),
  binEntry ?? '',
);
check('the package is publishable (not private)', pkg.private !== true, `private=${String(pkg.private)}`);
check(
  'engines declares the runtime the code needs',
  typeof pkg.engines?.node === 'string' && pkg.engines.node.length > 0,
  pkg.engines?.node ?? '(missing)',
);
check(
  'runtime dependencies are declared, not bundled implicitly',
  !!pkg.dependencies && Object.keys(pkg.dependencies).length > 0,
  Object.keys(pkg.dependencies ?? {}).join(', '),
);

if (typeof binEntry !== 'string') {
  console.log(`\n${failures} package check(s) failed; cannot continue to the protocol test`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The protocol test: a real MCP client over stdio, pointed at the installed bin.
// ---------------------------------------------------------------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(packageDir, binEntry)],
  env: {
    ...process.env,
    // A documentation address: this test must not need the real deployment, and must not depend on
    // whatever `.env` happens to sit next to the checkout.
    AXURE_URL: process.env.AXURE_URL || 'https://axure.example.com/MyProject',
  },
  stderr: 'pipe',
});

let stderrText = '';
transport.stderr?.on('data', (chunk) => {
  stderrText += String(chunk);
});

const client = new Client({ name: 'package-verifier', version: '0.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  const version = client.getServerVersion();
  check('MCP initialize handshake completes', !!version, `server=${version?.name}@${version?.version}`);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  const expected = [
    'axure_get_interactions',
    'axure_get_page_map',
    'axure_get_visual',
    'axure_list_pages',
    'axure_use_prototype',
  ];
  check('tools/list returns the full tool set', expected.every((name) => names.includes(name)), names.join(', '));

  check(
    'every tool declares an input schema',
    tools.every((tool) => !!tool.inputSchema && typeof tool.inputSchema === 'object'),
    `${tools.length} tools`,
  );

  // A call that must fail *cleanly* rather than crash: the address is a documentation host, so the
  // navigation fails. What matters is that the failure arrives as a protocol result with a code.
  const refused = await client.callTool({ name: 'axure_use_prototype', arguments: { url: 'file:///etc/passwd' } });
  const refusedText = refused.content?.find((block) => block.type === 'text')?.text ?? '';
  check(
    'a dangerous address is refused with a machine-readable code',
    refused.isError === true && /NAVIGATION_BLOCKED/.test(refusedText),
    refusedText.split('\n').find((line) => line.startsWith('error:')) ?? refusedText.split('\n')[0],
  );

  check(
    'the server stayed alive after a refused call',
    (await client.listTools()).tools.length === expected.length,
  );

  const instructions = client.getInstructions?.() ?? '';
  check(
    'server instructions tell a host that prototype text is untrusted',
    /UNTRUSTED DATA/i.test(instructions),
    `${instructions.length} chars`,
  );
} catch (error) {
  check('MCP handshake over stdio', false, String(error).split('\n')[0]);
  if (stderrText) console.log(`\nserver stderr:\n${stderrText.slice(0, 2_000)}`);
} finally {
  await client.close().catch(() => undefined);
}

console.log(`\n${failures === 0 ? 'package verification passed' : `${failures} package check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
