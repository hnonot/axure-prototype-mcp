/**
 * Unit checks that need no network or browser.
 *
 * The important one is the first: the extractor that is evaluated inside the Axure page
 * must be plain JavaScript. A TypeScript annotation that leaks into that template would
 * compile fine here and only explode inside Chromium at tool-call time, so the build
 * proves it up front.
 */

import assert from 'node:assert/strict';
import { EXTRACT_SOURCE } from '../dist/axure-page.js';
import { loadConfig, splitAxureUrl } from '../dist/config.js';
import { resolvePageUrl } from '../dist/axure-doc.js';
import { parseWidgetRef, renderOutline, flattenOutline } from '../dist/axure-page.js';
import { formatError, AxureError } from '../dist/errors.js';

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

test('EXTRACT_SOURCE is valid plain JavaScript', () => {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${EXTRACT_SOURCE}; return axureExtractOutline;`);
  assert.equal(typeof factory, 'function');
});

test('EXTRACT_SOURCE declares the extractor and needs no module scope', () => {
  assert.match(EXTRACT_SOURCE, /function axureExtractOutline\(options\)/);
  assert.doesNotMatch(EXTRACT_SOURCE, /\bimport\b/);
  assert.doesNotMatch(EXTRACT_SOURCE, /\brequire\(/);
});

test('splitAxureUrl separates origin and project path', () => {
  assert.deepEqual(splitAxureUrl('https://axure.example.com/ProjectB'), { origin: 'http://axure.example.com', projectPath: '/ProjectB' });
  assert.deepEqual(splitAxureUrl('http://host/a/b/'), { origin: 'http://host', projectPath: '/a/b' });
});

test('loadConfig reads AXURE_URL and derives the base URL', () => {
  const config = loadConfig({ AXURE_URL: 'http://example.test/PROJ/', AXURE_VIEWPORT_WIDTH: '800' });
  assert.equal(config.baseUrl, 'http://example.test/PROJ');
  assert.equal(config.defaultPageUrl, 'http://example.test/PROJ/');
  assert.equal(config.viewportWidth, 800);
  assert.equal(config.headless, true);
});

test('resolvePageUrl accepts page id, name, relative path and absolute URL', () => {
  const config = loadConfig({ AXURE_URL: 'http://host/PROJ' });
  const sitemap = {
    projectName: 'p',
    baseUrl: config.baseUrl,
    generatedAt: '',
    pageCount: 1,
    folderCount: 0,
    pages: [{ id: 'abc123', name: '订单管理', url: '订单管理.html', absoluteUrl: 'http://host/PROJ/%E8%AE%A2%E5%8D%95%E7%AE%A1%E7%90%86.html', path: [], type: 'Wireframe' }],
    folders: [],
  };
  assert.equal(resolvePageUrl('abc123', config, sitemap).pageId, 'abc123');
  assert.equal(resolvePageUrl('订单管理', config, sitemap).pageId, 'abc123');
  assert.equal(resolvePageUrl('订单管理', config, sitemap).url, sitemap.pages[0].absoluteUrl);
  assert.equal(resolvePageUrl('sub/page.html', config).url, 'http://host/PROJ/sub/page.html');
  assert.equal(resolvePageUrl('http://other/x.html', config).url, 'http://other/x.html');
  assert.equal(resolvePageUrl(undefined, config).url, 'http://host/PROJ/');
});

test('parseWidgetRef accepts bare ids and page-qualified refs', () => {
  assert.deepEqual(parseWidgetRef('u12'), { widgetId: 'u12' });
  assert.deepEqual(parseWidgetRef('abc#u12'), { pageId: 'abc', widgetId: 'u12' });
  assert.deepEqual(parseWidgetRef('  abc#u12  '), { pageId: 'abc', widgetId: 'u12' });
});

test('flattenOutline walks depth-first', () => {
  const tree = [
    { id: 'a', children: [{ id: 'a1' }, { id: 'a2', children: [{ id: 'a2x' }] }] },
    { id: 'b' },
  ];
  assert.deepEqual(flattenOutline(tree).map((node) => node.id), ['a', 'a1', 'a2', 'a2x', 'b']);
});

test('renderOutline emits the documented line format', () => {
  const text = renderOutline({
    page: { id: 'abc', name: '订单管理', url: 'http://h/p.html', title: 't', type: 'Wireframe', path: ['MES'] },
    space: 'page',
    pageSize: { width: 1920, height: 1080 },
    viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
    detail: 'standard',
    stats: { widgets: 1, nodes: 1, visibleNodes: 1, offCanvasNodes: 0, truncatedNodes: 0, omittedNodes: 0, interactiveNodes: 1, imageNodes: 0 },
    outline: [
      {
        id: 'u5', ref: 'abc#u5', depth: 0, kind: 'text', type: 'Rectangle',
        x: 10, y: 20, width: 200, height: 56, vx: 10, vy: 20, onScreen: true, visible: true,
        text: '库存管理', action: 'click', style: { fill: '#ffffff', radius: 4 },
      },
    ],
    omitted: {},
    warnings: [],
  });
  assert.match(text, /^# 订单管理 {2}\[abc\]/m);
  assert.match(text, /u5 text:Rectangle @10,20 200x56/);
  assert.match(text, /clickable/);
  assert.match(text, /text="库存管理"/);
  assert.match(text, /\[fill=#ffffff radius=4\]/);
  assert.match(text, /format: <id> <kind>:<AxureType>/);
});

test('formatError surfaces the stable error code and hint', () => {
  const text = formatError(new AxureError('WIDGET_NOT_FOUND', 'no such widget', 'call the map tool first'));
  assert.match(text, /error: WIDGET_NOT_FOUND/);
  assert.match(text, /hint: call the map tool first/);
  assert.match(formatError(new Error('boom')), /error: UNEXPECTED\nmessage: boom/);
});

console.log(`\n${failures === 0 ? 'all unit checks passed' : `${failures} unit check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
