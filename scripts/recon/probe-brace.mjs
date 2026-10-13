import { writeFileSync } from 'node:fs';
import { EXTRACT_SOURCE } from '../../dist/axure-page.js';

writeFileSync('../../recon-out/extract-source.js', `${EXTRACT_SOURCE}\nexport { axureExtractOutline };\n`);
console.log('written', EXTRACT_SOURCE.length);

// Balanced-brace scan with string/comment awareness to find the first structural break.
const src = EXTRACT_SOURCE;
let depth = 0;
let line = 1;
let inString = null;
let inLineComment = false;
let inBlockComment = false;
let inRegex = false;
let previousSignificant = '';
for (let i = 0; i < src.length; i += 1) {
  const ch = src[i];
  const next = src[i + 1];
  if (ch === '\n') {
    line += 1;
    inLineComment = false;
    continue;
  }
  if (inLineComment) continue;
  if (inBlockComment) {
    if (ch === '*' && next === '/') { inBlockComment = false; i += 1; }
    continue;
  }
  if (inString) {
    if (ch === '\\') { i += 1; continue; }
    if (ch === inString) inString = null;
    continue;
  }
  if (inRegex) {
    if (ch === '\\') { i += 1; continue; }
    if (ch === '/') inRegex = false;
    continue;
  }
  if (ch === '/' && next === '/') { inLineComment = true; continue; }
  if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue; }
  if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
  if (ch === '/' && /[=(,:;[!&|?{}+\-*%~^<>]/.test(previousSignificant || '=')) { inRegex = true; continue; }
  if (ch === '{') depth += 1;
  if (ch === '}') {
    depth -= 1;
    if (depth < 0) { console.log('depth went negative at line', line); break; }
  }
  if (!/\s/.test(ch)) previousSignificant = ch;
}
console.log('final depth', depth, '(0 means balanced)');

