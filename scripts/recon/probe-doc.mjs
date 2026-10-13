import { writeFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';

const BASE = process.env.AXURE_URL || 'https://axure.example.com/ProjectB';
mkdirSync('./recon-out', { recursive: true });

const res = await fetch(`${BASE}/data/document.js`, { headers: { 'User-Agent': 'node' } });
const text = await res.text();
console.log('fetched', res.status, text.length);

let captured = null;
const sandbox = {
  $axure: {
    loadDocument(doc) { captured = doc; },
    utils: {},
    player: {},
  },
  console,
  window: {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(text, sandbox, { timeout: 20000 });

console.log('captured type', typeof captured, captured && Object.keys(captured));
if (captured) {
  writeFileSync('./../../recon-out/document.json', JSON.stringify(captured, null, 2));
  const sitemap = captured.sitemap && captured.sitemap.rootNodes;
  const walk = (nodes, depth = 0) => {
    for (const n of nodes || []) {
      console.log('  '.repeat(depth) + `- pid=${n.pageName ?? ''} url=${n.url ?? ''} type=${n.type ?? ''} id=${n.id ?? ''}`);
      if (n.nodes) walk(n.nodes, depth + 1);
    }
  };
  console.log('--- sitemap ---');
  walk(sitemap);
}

