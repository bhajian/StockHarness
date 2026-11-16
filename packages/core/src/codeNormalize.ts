// #450: plugin code without comments or formatting, for the one-shot holdout key. Pure, so it is unit-tested.
import { createHash } from 'node:crypto';

const codeHash = (code: string) => `sha256:${createHash('sha256').update(code, 'utf8').digest('hex')}`;
/**
 * #450: the code with comments, blank lines and trailing whitespace removed, so a comment edit is the same code.
 * A `#` inside a string literal on the line (an even number of quotes before it) is kept.
 */
export function normalizedCode(code: string) {
  const out: string[] = [];
  for (const raw of code.replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw;
    for (let i = 0, single = 0, double = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === "'" && double % 2 === 0) single++;
      else if (c === '"' && single % 2 === 0) double++;
      else if (c === '#' && single % 2 === 0 && double % 2 === 0) {
        line = raw.slice(0, i);
        break;
      }
    }
    line = line.replace(/\s+$/, '');
    if (line.trim()) out.push(line);
  }
  return out.join('\n');
}
export const normalizedCodeHash = (code: string) => codeHash(normalizedCode(code));
