/** Extract the probe exactly as the compiled module defines it, and compile it in isolation. */
import { readFileSync } from 'node:fs';

const dist = readFileSync('dist/axure/prototype-url.js', 'utf8');
const marker = 'export const AXURE_URL_PROBE = ';
const start = dist.indexOf(marker);
if (start === -1) throw new Error('marker not found');
const bodyStart = dist.indexOf('`', start) + 1;
// Walk forward to the backtick that is not escaped: that is the real end of the template literal,
// rather than `lastIndexOf`, which happily matches a backtick inside a later comment.
let end = -1;
for (let i = bodyStart; i < dist.length; i += 1) {
  if (dist[i] === '`' && dist[i - 1] !== '\\') {
    end = i;
    break;
  }
}
const probe = dist.slice(bodyStart, end);
console.log('probe length:', probe.length, '| ends with:', JSON.stringify(probe.slice(-30)));
console.log('backticks inside probe:', (probe.match(/`/g) ?? []).length);
try {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${probe}; return axureExtractOutline;`)();
  console.log('compiles OK; factory type:', typeof fn);
} catch (error) {
  console.log('COMPILE ERROR:', String(error).split('\n')[0]);
}
