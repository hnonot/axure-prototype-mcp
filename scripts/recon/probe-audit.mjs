/** Throwaway probe: verify audit claim D1 (malformed AXURE_URL crashes at startup). */
import { loadConfig } from '../../dist/config.js';
import { resolvePageUrl } from '../../dist/axure-doc.js';

for (const value of ['http://', 'not a url', 'ftp://host/x', 'http://host:99999/x', '']) {
  try {
    const config = loadConfig({ AXURE_URL: value });
    console.log(`AXURE_URL=${JSON.stringify(value)} -> baseUrl=${config.baseUrl}`);
  } catch (error) {
    console.log(`AXURE_URL=${JSON.stringify(value)} -> THREW ${error.constructor.name}: ${error.message}`);
  }
}

console.log('\n--- viewport upper bound (D1) ---');
const big = loadConfig({ AXURE_VIEWPORT_WIDTH: '99999999', AXURE_VIEWPORT_HEIGHT: '99999999' });
console.log('accepted:', big.viewportWidth, big.viewportHeight);

console.log('\n--- SSRF / origin escape (A1, A3) ---');
const config = loadConfig({ AXURE_URL: 'https://axure.example.com/ProjectB' });
const sitemap = {
  projectName: 'p', baseUrl: config.baseUrl, generatedAt: '', pageCount: 0, folderCount: 0, pages: [], folders: [],
};
for (const selector of [
  'http://169.254.169.254/latest/meta-data/',
  '//evil.example/x',
  '../../other-app/index.html',
  'https://evil.example/',
  '/absolute/path.html',
]) {
  const resolved = resolvePageUrl(selector, config, sitemap);
  const escaped = !resolved.url.startsWith(config.baseUrl);
  console.log(`page=${JSON.stringify(selector).padEnd(46)} -> ${resolved.url}   ESCAPES_DEPLOYMENT=${escaped}`);
}

console.log('\n--- savePath escape (A4) ---');
const path = await import('node:path');
const cfg = loadConfig({ AXURE_SCREENSHOT_DIR: '.axure-mcp/shots' });
for (const savePath of ['../../../../Windows/Temp/evil.png', 'C:/Windows/Temp/evil.png']) {
  const destination = path.isAbsolute(savePath) ? savePath : path.resolve(cfg.screenshotDir, savePath);
  const insideBase = path.resolve(destination).startsWith(path.resolve(cfg.screenshotDir));
  console.log(`savePath=${JSON.stringify(savePath).padEnd(42)} -> ${path.resolve(destination)}   WITHIN_BASE=${insideBase}`);
}
