import { EXTRACT_SOURCE } from '../../dist/axure-page.js';
console.log('len', EXTRACT_SOURCE.length);
console.log('head', JSON.stringify(EXTRACT_SOURCE.slice(0, 60)));
console.log('tail', JSON.stringify(EXTRACT_SOURCE.slice(-260)));
try {
  const fn = new Function(`${EXTRACT_SOURCE}; return axureExtractOutline;`);
  console.log('SYNTAX OK', typeof fn);
} catch (error) {
  console.log('SYNTAX ERR', error.message);
  // bisect: find the offending line by compiling progressively
  const lines = EXTRACT_SOURCE.split('\n');
  for (let end = 2; end <= lines.length; end += 20) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(`${lines.slice(0, end).join('\n')}\n}`);
    } catch (error2) {
      console.log('first failing block ends at line', end, '-', error2.message);
      break;
    }
  }
}

