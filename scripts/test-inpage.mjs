/**
 * Guards for the in-page execution boundary.
 *
 * The adapter compiles a function **inside Chromium** from a string. That boundary is silent:
 * a reference to a Node-scope name compiles perfectly in TypeScript and then throws
 * `ReferenceError` only in the browser, which is exactly how a `FACTORY_NAME` constant once
 * broke every tool call. These tests reproduce the boundary in Node so the mistake fails here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXTRACT_SOURCE } from '../dist/axure/extract-source.js';

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

/**
 * The callback body the adapter hands to `frame.evaluate`, kept as a string so nothing from
 * this module can leak into its scope when it is compiled.
 */
const INBOUND_BODY = `function inbound(payload) {
  const factory = new Function(payload.declaration + '; return axureExtractOutline;')();
  return factory(payload.value);
}`;

const buildInbound = () =>
  // eslint-disable-next-line no-new-func
  new Function(`${INBOUND_BODY}; return inbound;`)();

test('the adapter in-page callback compiles with no module scope', () => {
  assert.equal(typeof buildInbound(), 'function');
});

/** Browser globals the extractor is expected to touch; anything else is a boundary leak. */
const BROWSER_GLOBALS = new Set(['document', 'window', 'getComputedStyle', 'location', 'HTMLElement', 'Map', 'Set']);

test('the adapter in-page callback can build the extractor', () => {
  const inbound = buildInbound();
  try {
    const result = inbound({ declaration: EXTRACT_SOURCE, value: { includeNotes: false } });
    assert.equal(typeof result, 'object');
  } catch (error) {
    const missing = /ReferenceError:\s+([\w$]+) is not defined/.exec(String(error));
    assert.ok(missing, `unexpected failure: ${error}`);
    // In Node the extractor can only get as far as its first DOM access. Any *other* missing
    // identifier means it depends on module scope, which does not exist inside the page.
    assert.ok(
      BROWSER_GLOBALS.has(missing[1]),
      `the extractor references "${missing[1]}", which is not a browser global`,
    );
  }
});

test('the compiled adapter does not interpolate module names into in-page code', () => {
  // Structural check for the same class of bug: the in-page callback must be a literal string
  // function or reference only its own parameters and browser globals.
  const source = readFileSync(new URL('../dist/playwright/adapter.js', import.meta.url), 'utf8');
  const callbacks = source.match(/frame\.evaluate\([\s\S]{0,400}?\)/g) ?? [];
  assert.ok(callbacks.length > 0, 'the adapter must still call frame.evaluate');
  for (const callback of callbacks) {
    const interpolation = callback.match(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g) ?? [];
    for (const hit of interpolation) {
      const name = hit.replace(/[${}\s]/g, '');
      assert.ok(
        ['declaration', 'value', 'source', 'arg'].includes(name),
        `frame.evaluate interpolates "${name}", which is not in the in-page payload`,
      );
    }
  }
});

test('every in-page snippet defines the axureExtractOutline convention', () => {
  // The adapter has exactly one in-page convention, and a snippet that does not follow it fails
  // only at run time inside Chromium. Scan every source file that contains in-page code and
  // check the declarations it hands to `run()`.
  const files = ['../dist/axure/extract-source.js', '../dist/axure/sitemap.js', '../dist/service.js'];
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    // Template literals passed to run(...) that declare a function.
    for (const match of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1];
      if (name !== 'axureExtractOutline' && /axure[A-Z]/.test(name)) {
        offenders.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `in-page snippets must define axureExtractOutline: ${offenders.join(', ')}`);
});

test('the compiled adapter exposes a single in-page entry point', () => {
  const source = readFileSync(new URL('../dist/playwright/adapter.js', import.meta.url), 'utf8');
  assert.match(source, /return axureExtractOutline;/);
  assert.equal(
    /return \(code\);/.test(source),
    false,
    'the expression-evaluation path was removed deliberately; keep one convention',
  );
});

test('the extractor declares the factory name the adapter asks for', () => {
  assert.match(EXTRACT_SOURCE, /function axureExtractOutline\(options\)/);
});

console.log(`\n${failures === 0 ? 'all in-page isolation checks passed' : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
