import { readFileSync } from 'node:fs';
const src = readFileSync('../../src/axure-page.ts', 'utf8');
const match = /EXTRACT_SOURCE = String\.raw`([\s\S]*?)`;\n/.exec(src);
if (!match) throw new Error('no match');
const body = match[1];
const lines = body.split('\n');
console.log('lines:', lines.length);
for (let i = 0; i < 4; i += 1) console.log(`L${i + 1}:`, JSON.stringify(lines[i]));
try {
  new Function(`${body}; return axureExtractOutline;`);
  console.log('SYNTAX OK');
} catch (error) {
  console.log('SYNTAX ERR', error.message);
}
// find the marker
const marker = 'const collected';
console.log('marker at index', body.indexOf(marker));
console.log('tail:', JSON.stringify(body.slice(body.indexOf(marker) - 40, body.indexOf(marker) + 60)));

