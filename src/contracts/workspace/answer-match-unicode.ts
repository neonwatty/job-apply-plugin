import { ranges as assignedBmp } from './answer-match-unicode-assigned-bmp.js';
import { ranges as assignedAstral } from './answer-match-unicode-assigned-astral.js';
import { ranges as alnumBmp } from './answer-match-unicode-alnum-bmp.js';
import { ranges as alnumAstral } from './answer-match-unicode-alnum-astral.js';

type Ranges = readonly (readonly [number, number])[];
function contains(ranges: Ranges, point: number): boolean {
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2), range = ranges[middle]!;
    if (point < range[0]) high = middle;
    else if (point > range[1]) low = middle + 1;
    else return true;
  }
  return false;
}

/** Newer Unicode assignments must remain inert, as in Python 3.12.
 * Normalization is stable for already-assigned characters. Unassigned characters
 * have combining class zero and therefore safely delimit normalization runs.
 */
export function normalizeMatcherText(value: string): string {
  const result: string[] = [];
  let assigned = '';
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (contains(point < 0x10000 ? assignedBmp : assignedAstral, point)) assigned += char;
    else {
      if (assigned) result.push(assigned.normalize('NFKC'));
      result.push(char);
      assigned = '';
    }
  }
  if (assigned) result.push(assigned.normalize('NFKC'));
  return result.join('');
}

/** Python re's Unicode [^\W_]+ uses the fixed str.isalnum repertoire. */
export function matcherTokens(value: string): string[] {
  const tokens: string[] = [];
  let token = '';
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (contains(point < 0x10000 ? alnumBmp : alnumAstral, point)) token += char;
    else if (token) {
      tokens.push(token);
      token = '';
    }
  }
  if (token) tokens.push(token);
  return tokens;
}
