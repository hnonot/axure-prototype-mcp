import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('../../src/axure/interaction-source.ts', import.meta.url), 'utf8');
const start = text.indexOf('export const INTERACTION_SOURCE = `');
const bodyStart = text.indexOf('`', start) + 1;
const bodyEnd = text.lastIndexOf('`;');
const SOURCE = text.slice(bodyStart, bodyEnd);

const axure = {
  document: {
    pages: [{ objects: [{ id: 'u1', link: { type: 'navigate' } }] }],
    links: [{ id: 'u1', interactionMap: { onClick: [] } }],
  },
};

const factory = new Function(
  'window',
  'document',
  'getComputedStyle',
  `${SOURCE}; return axureExtractOutline;`,
)({ $axure: axure }, { getElementById: () => null, body: { querySelectorAll: () => [] } }, () => ({ cursor: 'auto' }));

const result = factory({ maxWidgets: 400 });
console.log('rootsFound:', JSON.stringify(result.rootsFound));
console.log('entries:', JSON.stringify(result.entries, null, 1));
console.log('gaps:', JSON.stringify(result.gaps, null, 1));
