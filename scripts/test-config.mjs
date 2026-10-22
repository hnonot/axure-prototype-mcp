/**
 * Every setting in `.env.example` must actually change how the server runs.
 *
 * ## Why this suite exists
 *
 * The 0.2.4 iteration started from a check of `.env.example` against the code. Four entries were
 * listed but inert:
 *
 * | Entry | Was | Why |
 * |---|---|---|
 * | `AXURE_HTTP_PORT` / `_HOST` / `_TOKEN` | read straight off `process.env` | the merged environment was discarded, so a value in `.env` never reached the HTTP branch |
 * | `AXURE_DEBUG` | no reader at all | `AXURE_LOG_LEVEL` is the real knob |
 * | `AXURE_MAX_WIDGET_IDS` | parsed, validated, advertised in `--help` | the widget-id bound was a hard-coded `40` |
 *
 * A setting that is documented, accepted and silently ignored is worse than an absent one: the
 * operator cannot tell it from one that worked. So this suite asserts the property directly, for
 * every key the template lists:
 *
 * 1. the key appears in a table here that names its effect (adding one without wiring it fails);
 * 2. setting it in `.env` changes the configuration the server derives — proven by loading a real
 *    file, not by inspecting the source;
 * 3. the keys that never reach the configuration object (the HTTP transport, the tool-schema
 *    bound, the log level) are proven by **starting the server** with that `.env`.
 *
 * It also checks the reverse direction: every `AXURE_*` name the code reads is listed in the
 * template, so a new setting cannot be added without being documented.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { loadProcessEnv } from '../dist/env-file.js';
import { loadConfig } from '../dist/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(root, '.env.example'), 'utf8');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** Run one assertion, sync or async, and report it without stopping the suite. */
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
};

/** Write a real `.env` in a fresh directory; the caller removes it. */
const envDir = (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'axure-config-'));
  writeFileSync(join(dir, '.env'), body);
  return dir;
};
/**
 * Remove a temporary directory, tolerating the moment Windows needs to release it.
 *
 * A killed child keeps its working directory open for a few milliseconds; without the retry the
 * cleanup throws `EBUSY` and hides the assertions that had not run yet.
 */
const dropDir = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/** Kill a child and wait for it to actually exit, so its directory can be removed. */
const stop = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
};

/** The environment a child gets: no AXURE_* at all, so only its own `.env` can supply one. */
const bareEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('AXURE_')) env[key] = value;
  }
  return env;
};

const launch = (dir, args) =>
  spawn(process.execPath, [join(root, 'bin/axure-mcp.mjs'), ...args], {
    cwd: dir,
    env: bareEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

const runToExit = (child) =>
  new Promise((resolvePromise) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stderr });
    });
  });

/** A port nothing is listening on, chosen by the OS. */
const freePort = () =>
  new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });

const waitForHealth = async (port, deadlineMs = 25_000) => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return undefined;
};

/* ========================================================================== */
/* The contract: one entry per setting, naming where it takes effect          */
/* ========================================================================== */

/**
 * Keys whose effect is the configuration object.
 *
 * `value` is written into `.env`; `reached` is the assertion it must satisfy. A key listed in the
 * template but absent from this table — and from the two sets below — fails the completeness test,
 * which is what stops a new entry from shipping inert.
 */
const CONFIG_EFFECTS = [
  ['AXURE_URL', 'https://axure.example.com/MyProject', (c) => c.baseUrl === 'https://axure.example.com/MyProject'],
  ['AXURE_ALLOWED_HOSTS', 'assets.example.com', (c) => c.allowedHosts.join(',') === 'assets.example.com'],
  ['AXURE_HEADLESS', 'false', (c) => c.headless === false],
  ['AXURE_VIEWPORT_WIDTH', '1600', (c) => c.viewportWidth === 1600],
  ['AXURE_VIEWPORT_HEIGHT', '1000', (c) => c.viewportHeight === 1000],
  ['AXURE_DEVICE_SCALE_FACTOR', '2', (c) => c.deviceScaleFactor === 2],
  ['AXURE_MAX_CAPTURE_VIEWPORT_WIDTH', '5000', (c) => c.maxCaptureViewportWidth === 5000],
  ['AXURE_MAX_CAPTURE_VIEWPORT_HEIGHT', '4000', (c) => c.maxCaptureViewportHeight === 4000],
  ['AXURE_NAV_TIMEOUT_MS', '45000', (c) => c.navigationTimeoutMs === 45000],
  ['AXURE_OPERATION_TIMEOUT_MS', '15000', (c) => c.operationTimeoutMs === 15000],
  ['AXURE_SETTLE_MS', '2500', (c) => c.settleMs === 2500],
  ['AXURE_MAX_OUTLINE_NODES', '600', (c) => c.maxOutlineNodes === 600],
  ['AXURE_OUTLINE_CHAR_BUDGET', '20000', (c) => c.outlineCharBudget === 20000],
  ['AXURE_MAX_WIDGET_IDS', '7', (c) => c.maxWidgetIds === 7],
  ['AXURE_MAX_INTERACTION_WIDGETS', '250', (c) => c.maxInteractionWidgets === 250],
  ['AXURE_MAX_PAGES', '120', (c) => c.maxPages === 120],
  ['AXURE_BROWSER_IDLE_MS', '60000', (c) => c.browserIdleMs === 60000],
  ['AXURE_NO_PROXY', 'example.internal', (c) => c.noProxy === 'example.internal'],
  ['AXURE_SCREENSHOT_DIR', 'shots-from-env', (c) => c.screenshotDir === 'shots-from-env'],
  ['AXURE_LOG_LEVEL', 'warn', (c) => c.logLevel === 'warn'],
];

/**
 * Keys that never reach `AxureConfig`, each proven by starting the server below.
 *
 * - the three HTTP settings are read by the entry point, not by `loadConfig`;
 * - `AXURE_ENV_FILE` is read before any file exists, so it can only come from the process
 *   environment. That is what the variable does, not a defect, and the template says so in place.
 */
const RUNTIME_EFFECTS = new Set(['AXURE_HTTP_PORT', 'AXURE_HTTP_HOST', 'AXURE_HTTP_TOKEN']);
const PROCESS_ONLY = new Set(['AXURE_ENV_FILE']);

/** Every `KEY=` line in the template, including the commented examples. */
const listedKeys = () => {
  const keys = new Set();
  for (const line of template.split(/\r?\n/)) {
    const match = /^\s*#?\s*(AXURE_[A-Z0-9_]+)\s*=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
};

/* ========================================================================== */
/* 1. The template and the code list the same settings                        */
/* ========================================================================== */

await test('every key in .env.example has a stated, tested effect', () => {
  const known = new Set([...CONFIG_EFFECTS.map(([key]) => key), ...RUNTIME_EFFECTS, ...PROCESS_ONLY]);
  const unknown = [...listedKeys()].filter((key) => !known.has(key));
  assert.deepEqual(unknown, [], `listed but not wired: ${unknown.join(', ')}`);
});

await test('the template lists every AXURE_* name the code reads', () => {
  // Reverse drift: a setting added to the code but never documented is invisible to an operator.
  const sources = ['bin/axure-mcp.mjs', 'src/config.ts', 'src/env-file.ts'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
  const read = new Set();
  for (const source of sources) {
    // `env.`, `base.` and `process.env.` are the three shapes an environment read takes here.
    // A name only mentioned in prose or declared as a constant (such as the in-page probe) is not
    // a setting and is deliberately not matched.
    for (const match of source.matchAll(/\b(?:env|base)\.(AXURE_[A-Z0-9_]+)\b/g)) read.add(match[1]);
  }
  assert.ok(read.size >= 20, `expected to find the settings, found ${read.size}`);
  const missing = [...read].filter((key) => !listedKeys().has(key));
  assert.deepEqual(missing, [], `read by the code but missing from .env.example: ${missing.join(', ')}`);
});

await test('the inert AXURE_DEBUG entry is gone rather than left as decoration', () => {
  assert.equal(listedKeys().has('AXURE_DEBUG'), false);
  assert.ok(listedKeys().has('AXURE_LOG_LEVEL'), 'AXURE_LOG_LEVEL replaces it');
});

await test('the template port matches the code default, so a copied file changes nothing', () => {
  // It used to say 7458 while `--help` and the code said 3333: copying the template silently moved
  // the endpoint. The value now equals the default, so copying is a no-op.
  assert.match(template, /^AXURE_HTTP_PORT=3333$/m);
});

/* ========================================================================== */
/* 2. Each key, set in a real .env, changes the configuration                 */
/* ========================================================================== */

for (const [key, value, reached] of CONFIG_EFFECTS) {
  await test(`.env ${key} reaches the configuration`, () => {
    const body =
      key === 'AXURE_URL' ? `${key}=${value}\n` : `AXURE_URL=https://axure.example.com/MyProject\n${key}=${value}\n`;
    const dir = envDir(body);
    try {
      // An empty process environment: the file is the only possible source.
      const { env, file } = loadProcessEnv({}, { startDir: dir });
      assert.equal(file.path, join(dir, '.env'), 'the temporary file must be the one read');
      assert.ok(reached(loadConfig(env)), `${key} did not reach the configuration`);
    } finally {
      dropDir(dir);
    }
  });
}

/* ========================================================================== */
/* 3. The HTTP transport reads its settings from .env                         */
/* ========================================================================== */

{
  const port = await freePort();
  const token = 'config-test-token-0123456789';
  const dir = envDir(`AXURE_URL=https://axure.example.com/MyProject\nAXURE_HTTP_PORT=${port}\nAXURE_HTTP_TOKEN=${token}\n`);
  const child = launch(dir, ['--http']);
  try {
    const health = await waitForHealth(port);
    check(
      'AXURE_HTTP_PORT from .env decides the port the server binds',
      health !== undefined,
      health ? `listening on ${port}` : `nothing answered on ${port}`,
    );
    check(
      'AXURE_HTTP_TOKEN from .env is applied',
      health?.authenticated === true,
      `authenticated=${String(health?.authenticated)}`,
    );

    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    check('the token from .env is enforced', unauthorized.status === 401, `status ${unauthorized.status}`);

    const authorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    check('the token from .env admits the matching bearer token', authorized.ok, `status ${authorized.status}`);
  } catch (error) {
    check('http settings from .env', false, error instanceof Error ? error.message : String(error));
  } finally {
    await stop(child);
    dropDir(dir);
  }
}

{
  // The host is the one setting provable by *refusing* to start: a non-loopback bind without a
  // token must fail closed. If AXURE_HTTP_HOST were still ignored the server would bind 127.0.0.1,
  // start happily, and this case would time out instead of passing.
  const dir = envDir('AXURE_URL=https://axure.example.com/MyProject\nAXURE_HTTP_HOST=0.0.0.0\n');
  const { code, stderr } = await runToExit(launch(dir, ['--http']));
  dropDir(dir);
  check(
    'AXURE_HTTP_HOST from .env is honoured (refused without a token)',
    code !== 0 && /AXURE_HTTP_TOKEN/.test(stderr),
    `exit=${code}`,
  );
}

/* ========================================================================== */
/* 4. AXURE_MAX_WIDGET_IDS reaches the published tool schema                  */
/* ========================================================================== */

{
  // Invisible in `AxureConfig`: the bound used to be a hard-coded 40 in the Zod schema, so the
  // setting was accepted and ignored. Reading the schema a client receives is the only check that
  // proves it changed.
  const dir = envDir('AXURE_URL=https://axure.example.com/MyProject\nAXURE_MAX_WIDGET_IDS=7\n');
  let client;
  try {
    client = new Client({ name: 'config-audit', version: '0.0.0' }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, 'bin/axure-mcp.mjs')],
        cwd: dir,
        env: bareEnv(),
        stderr: 'pipe',
      }),
    );
    const { tools } = await client.listTools();
    for (const name of ['axure_get_page_map', 'axure_get_visual']) {
      const widgetIds = tools.find((tool) => tool.name === name)?.inputSchema?.properties?.widgetIds;
      check(`AXURE_MAX_WIDGET_IDS bounds ${name}`, widgetIds?.maxItems === 7, `maxItems=${String(widgetIds?.maxItems)}`);
    }
  } catch (error) {
    check('AXURE_MAX_WIDGET_IDS reaches the tool schema', false, error instanceof Error ? error.message : String(error));
  } finally {
    await client?.close().catch(() => undefined);
    dropDir(dir);
  }
}

/* ========================================================================== */
/* 5. AXURE_LOG_LEVEL changes what is written to stderr                        */
/* ========================================================================== */

/**
 * Start the server with a given log level and report whether a startup line appeared.
 *
 * stdin stays open, so the server keeps running rather than shutting down on a closed pipe: the
 * negative case needs the process alive long enough to have logged, or its silence proves nothing.
 */
const stderrOf = async (level, marker) => {
  const dir = envDir(`AXURE_URL=https://axure.example.com/MyProject\nAXURE_LOG_LEVEL=${level}\n`);
  const child = launch(dir, []);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    if (stderr.includes(marker)) break;
    if (Date.now() - started > 2_500) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    new Promise((r) => setTimeout(r, 3_000)),
  ]);
  dropDir(dir);
  return { matched: stderr.includes(marker), stderr };
};

{
  const shown = await stderrOf('info', 'starting stdio transport');
  check('AXURE_LOG_LEVEL=info keeps the startup line', shown.matched, shown.stderr.split('\n')[0] ?? '(no output)');

  const hidden = await stderrOf('error', 'starting stdio transport');
  check(
    'AXURE_LOG_LEVEL=error suppresses it, so the setting has an effect',
    !hidden.matched,
    hidden.matched ? 'the info line was printed anyway' : 'silent, as configured',
  );
}

console.log(`\n${failures === 0 ? 'all configuration checks passed' : `${failures} configuration check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
