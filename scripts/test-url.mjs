/**
 * Caller-supplied prototype addresses: the pre-check, and Axure recognition.
 *
 * Two behaviours are under test here, and both are the point of the 0.2.2 iteration:
 *
 * 1. **`.env` is read, and `AXURE_URL` has no default.** The reported bug was that an operator
 *    edited an address and the server kept reading a different prototype. Every case below is a
 *    regression test for one way that happened.
 * 2. **A runtime address is verified, not trusted.** `preflightPrototypeUrl` and
 *    `recognizePrototype` are pure, so the whole admission policy is checkable without a browser.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEnvFile, findEnvFile, loadProcessEnv, envSearchPath } from '../dist/env-file.js';
import { preflightPrototypeUrl, recognizePrototype } from '../dist/axure/prototype-url.js';
import { loadConfig, CONFIG_DEFAULTS } from '../dist/config.js';

let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
};

/* ========================================================================== */
/* The reported bug: an address that is edited but never read                 */
/* ========================================================================== */

test('AXURE_URL has no built-in default', () => {
  // The type-level statement: the defaults table must not carry an address.
  assert.equal('AXURE_URL' in CONFIG_DEFAULTS, false, 'CONFIG_DEFAULTS must not define AXURE_URL');
  assert.equal(CONFIG_DEFAULTS.AXURE_URL, undefined);
});

test('a missing AXURE_URL fails instead of reading some other prototype', () => {
  assert.throws(() => loadConfig({}), /AXURE_URL: is required/);
});

test('.env is parsed for the forms users actually write', () => {
  const { values, problems } = parseEnvFile(
    [
      '# a comment',
      '',
      'AXURE_URL=https://axure.example.com/MyProject',
      'export AXURE_SETTLE_MS=5000',
      'AXURE_HEADLESS = false',
      'QUOTED="a value with spaces"',
      'SINGLE=\'literal \\n stays\'',
      'TRAILING=value # an inline comment',
      'HASH=https://host/page#fragment',
    ].join('\n'),
  );
  assert.equal(values.get('AXURE_URL'), 'https://axure.example.com/MyProject');
  assert.equal(values.get('AXURE_SETTLE_MS'), '5000');
  assert.equal(values.get('AXURE_HEADLESS'), 'false');
  assert.equal(values.get('QUOTED'), 'a value with spaces');
  assert.equal(values.get('SINGLE'), 'literal \\n stays', 'single quotes are literal');
  assert.equal(values.get('TRAILING'), 'value');
  assert.equal(values.get('HASH'), 'https://host/page#fragment', 'a fragment is not a comment');
  assert.deepEqual(problems, []);
});

test('an unparseable .env line is reported, never silently skipped', () => {
  // A silently ignored AXURE_URL line is the bug being fixed, so this must not be quiet.
  const { values, problems } = parseEnvFile('AXURE_URL\nGOOD=1\n"bad name"=2');
  assert.equal(values.get('GOOD'), '1');
  assert.equal(problems.length, 2, `expected 2 problems, saw ${JSON.stringify(problems)}`);
  assert.ok(problems.some((problem) => /expected KEY=value/.test(problem)));
  assert.ok(problems.some((problem) => /not a valid variable name/.test(problem)));
});

test('an unterminated quote is reported rather than guessed at', () => {
  const { problems } = parseEnvFile('AXURE_URL="https://host/x\n');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unterminated double-quoted value/);
});

test('.env is found by walking up from a subdirectory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axure-env-'));
  try {
    writeFileSync(join(dir, '.env'), 'AXURE_URL=https://from-file.example/Project\n');
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    assert.equal(findEnvFile(undefined, nested), join(dir, '.env'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the checkout .env is found even when the working directory is unrelated', () => {
  // Regression for a real report: VSCode's MCP client launches the server with the *editor's*
  // folder as the working directory, so a search anchored only on `process.cwd()` did not find a
  // `.env` sitting beside `bin/axure-mcp.mjs`. With `AXURE_URL` required that made the server fail
  // to start from that host even though the configuration was perfectly correct.
  const checkout = mkdtempSync(join(tmpdir(), 'axure-checkout-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'axure-cwd-'));
  try {
    const bin = join(checkout, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(checkout, '.env'), 'AXURE_URL=https://beside-the-script.example/Project\n');

    // The point is that a search from `elsewhere` alone cannot see the checkout's file: whatever it
    // finds (nothing, or an unrelated file further up) must not be the one beside the script.
    assert.notEqual(findEnvFile(undefined, elsewhere), join(checkout, '.env'));

    // With the script directory supplied, the checkout's `.env` is found.
    assert.equal(findEnvFile(undefined, elsewhere, [bin]), join(checkout, '.env'));

    const { env, file } = loadProcessEnv({}, { startDir: elsewhere, extraStarts: [bin] });
    assert.equal(env.AXURE_URL, 'https://beside-the-script.example/Project');
    assert.equal(file.path, join(checkout, '.env'));
    assert.equal(loadConfig(env).baseUrl, 'https://beside-the-script.example/Project');
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('the working directory still takes priority when it has the .env', () => {
  // The extra anchor is a fallback, not an override: a project-local `.env` must keep winning.
  const checkout = mkdtempSync(join(tmpdir(), 'axure-checkout-'));
  const cwdDir = mkdtempSync(join(tmpdir(), 'axure-cwd-'));
  try {
    writeFileSync(join(checkout, '.env'), 'AXURE_URL=https://from-checkout.example/Project\n');
    writeFileSync(join(cwdDir, '.env'), 'AXURE_URL=https://from-cwd.example/Project\n');
    const { env, file } = loadProcessEnv({}, { startDir: cwdDir, extraStarts: [checkout] });
    assert.equal(file.path, join(cwdDir, '.env'));
    assert.equal(env.AXURE_URL, 'https://from-cwd.example/Project');
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  }
});

test('the failure message can name every path that was searched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axure-env-'));
  try {
    const paths = envSearchPath(dir, [join(dir, 'bin')]);
    assert.ok(paths.length > 0, 'at least one candidate path is reported');
    assert.ok(paths.every((candidate) => candidate.endsWith('.env')));
    // A missing address must be diagnosable without guesswork, so the paths are deduplicated and
    // ordered from the working directory outward.
    assert.equal(new Set(paths).size, paths.length, 'no duplicates');
    assert.equal(paths[0], join(dir, '.env'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.env supplies a value the process environment did not set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axure-env-'));
  try {
    writeFileSync(join(dir, '.env'), 'AXURE_URL=https://from-file.example/Project\n');
    const { env, file } = loadProcessEnv({}, { startDir: dir });
    assert.equal(env.AXURE_URL, 'https://from-file.example/Project');
    assert.ok(file.path);
    assert.deepEqual(file.overridden, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the process environment outranks .env, and says so', () => {
  // Precedence has to keep explicit host/container configuration winning, and the fact that the
  // file did not apply must be visible — that is what made the original bug confusing.
  const dir = mkdtempSync(join(tmpdir(), 'axure-env-'));
  try {
    writeFileSync(join(dir, '.env'), 'AXURE_URL=https://from-file.example/Project\n');
    const { env, file } = loadProcessEnv({ AXURE_URL: 'https://from-env.example/Project' }, { startDir: dir });
    assert.equal(env.AXURE_URL, 'https://from-env.example/Project');
    assert.deepEqual(file.overridden, ['AXURE_URL']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty process variable does not shadow .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axure-env-'));
  try {
    writeFileSync(join(dir, '.env'), 'AXURE_URL=https://from-file.example/Project\n');
    const { env } = loadProcessEnv({ AXURE_URL: '' }, { startDir: dir });
    assert.equal(env.AXURE_URL, 'https://from-file.example/Project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a .env address becomes the configured base URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axure-env-'));
  try {
    writeFileSync(join(dir, '.env'), 'AXURE_URL=https://from-file.example/Project\n');
    const { env } = loadProcessEnv({}, { startDir: dir });
    assert.equal(loadConfig(env).baseUrl, 'https://from-file.example/Project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit AXURE_ENV_FILE is honoured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axure-env-'));
  try {
    const custom = join(dir, 'custom.env');
    writeFileSync(custom, 'AXURE_URL=https://explicit.example/Project\n');
    const { env } = loadProcessEnv({ AXURE_ENV_FILE: custom }, { startDir: tmpdir() });
    assert.equal(env.AXURE_URL, 'https://explicit.example/Project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ========================================================================== */
/* Stage 1: the syntactic pre-check                                           */
/* ========================================================================== */

test('a plain https address passes and is normalized', () => {
  const result = preflightPrototypeUrl('https://axure.example.com/MyProject/');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://axure.example.com/MyProject', 'a trailing slash is dropped');
  assert.equal(result.host, 'axure.example.com');
  assert.equal(result.origin, 'https://axure.example.com');
});

test('an internal http address is allowed, because that is the normal case', () => {
  // A private range on a documentation host: the point is that the *shape* is permitted, since
  // reading internal prototypes is this tool's purpose.
  const result = preflightPrototypeUrl('http://192.168.10.20/MyProject');
  assert.equal(result.ok, true);
  assert.equal(result.host, '192.168.10.20');
});

test('a non-web scheme is refused', () => {
  for (const url of ['file:///etc/passwd', 'ftp://host/x', 'data:text/html,<h1>x', 'javascript:alert(1)']) {
    const result = preflightPrototypeUrl(url);
    assert.equal(result.ok, false, `${url} must be refused`);
    assert.equal(result.reason, 'unsupported-scheme');
  }
});

test('cloud instance-metadata addresses are refused', () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/v2/credentials',
    'http://100.100.100.200/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ]) {
    const result = preflightPrototypeUrl(url);
    assert.equal(result.ok, false, `${url} must be refused`);
    assert.equal(result.reason, 'metadata-endpoint');
  }
});

test('service ports used for internal attacks are refused', () => {
  for (const url of ['http://host:6379/', 'http://host:22/', 'http://host:3306/', 'http://host:11211/']) {
    const result = preflightPrototypeUrl(url);
    assert.equal(result.ok, false, `${url} must be refused`);
    assert.equal(result.reason, 'blocked-port');
  }
});

test('an unusual high port is allowed, since a prototype may use one', () => {
  assert.equal(preflightPrototypeUrl('http://host:8443/Project').ok, true);
  assert.equal(preflightPrototypeUrl('http://host:18080/Project').ok, true);
});

test('credentials embedded in the URL are refused', () => {
  const result = preflightPrototypeUrl('https://user:secret@axure.example.com/Project');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'credentials-in-url');
});

test('an empty or malformed value is refused with a reason', () => {
  assert.equal(preflightPrototypeUrl('').reason, 'not-a-url');
  assert.equal(preflightPrototypeUrl('   ').reason, 'not-a-url');
  assert.equal(preflightPrototypeUrl('not a url').reason, 'not-a-url');
  assert.equal(preflightPrototypeUrl('//axure.example.com/Project').reason, 'not-a-url');
});

test('the scheme-relative form cannot smuggle an origin past the check', () => {
  // `//evil.example/x` has no scheme, so it is not a valid absolute URL and is refused outright
  // rather than being resolved against anything.
  assert.equal(preflightPrototypeUrl('//evil.example/x').ok, false);
});

/* ========================================================================== */
/* Stage 2: Axure recognition                                                 */
/* ========================================================================== */

const probe = (overrides = {}) => ({
  signals: [],
  url: 'https://axure.example.com/MyProject/',
  title: 'My Project',
  scriptCount: 3,
  hasRuntime: false,
  hasBase: false,
  ...overrides,
});

test('the Axure runtime is what admits a host', () => {
  const result = recognizePrototype([
    probe({ hasRuntime: true, signals: ['axure-runtime:function'] }),
    probe({ hasBase: true, signals: ['base-canvas', 'widget-canvas'] }),
  ]);
  assert.equal(result.ok, true);
  assert.ok(result.signals.includes('axure-runtime'));
  assert.ok(result.signals.includes('base-canvas'), 'supporting signals are reported too');
  assert.equal(result.frames, 2);
});

test('an object-shaped runtime is accepted as well as a function', () => {
  // A share link exposes `$axure` as a function; a published export exposes an object. Both are Axure.
  assert.equal(recognizePrototype([probe({ hasRuntime: true })]).ok, true);
});

test('a page with no runtime is refused even if it has the supporting signals', () => {
  // This is the important case: `#base` and `data.js` alone are not Axure, and admitting them would
  // make the check meaningless.
  const result = recognizePrototype([
    probe({ signals: ['base-canvas', 'data-js', 'axure-runtime-script'], hasBase: true }),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.detail, /no Axure runtime was found/);
  assert.match(result.detail, /not sufficient on its own/, 'the reason must explain why it was not enough');
});

test('a page with nothing Axure-like is refused and says so', () => {
  const result = recognizePrototype([probe()]);
  assert.equal(result.ok, false);
  assert.match(result.detail, /none of the expected Axure structures/);
});

test('recognition fails closed when no frame produced a probe', () => {
  const result = recognizePrototype([]);
  assert.equal(result.ok, false, 'no evidence must never be treated as evidence');
  assert.equal(result.frames, 0);
});

test('recognition reports the runtime found in any one frame', () => {
  // The shell frame carries the runtime while the content frame carries the widgets; either is
  // enough, which is why every frame is probed.
  const result = recognizePrototype([
    probe({ hasRuntime: false, hasBase: true }),
    probe({ hasRuntime: true }),
    probe({ hasRuntime: false }),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.frames, 3);
});

test('recognition is deterministic and does not depend on frame order', () => {
  const forward = recognizePrototype([probe({ hasRuntime: true, signals: ['b'] }), probe({ signals: ['a'] })]);
  const reverse = recognizePrototype([probe({ signals: ['a'] }), probe({ hasRuntime: true, signals: ['b'] })]);
  assert.deepEqual(forward.signals, reverse.signals);
});

console.log(`\n${failures === 0 ? 'all prototype-address checks passed' : `${failures} prototype-address check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
