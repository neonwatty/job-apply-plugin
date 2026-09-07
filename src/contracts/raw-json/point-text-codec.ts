import { PythonText } from "../python-text.js";

const textPoints = Object.getOwnPropertyDescriptor(PythonText.prototype, "codePoints")!.get!;

/** Read the accepted leaf's private content, not a subclass accessor. */
export function pointContents(text: PythonText): readonly number[] {
  return textPoints.call(text);
}

/** Structured syntax facts shared by both facades, independent of public errors. */
export class PointSyntaxError extends Error {
  constructor(readonly reason: string, readonly position: number,
    readonly trailing?: { kind: "array" | "object"; comma: number }) {
    super(reason);
    this.name = "PointSyntaxError";
  }
}

const shortEscapes = new Map<number, number>([
  [34, 34], [92, 92], [47, 47], [98, 8], [102, 12], [110, 10], [114, 13], [116, 9],
]);

function hexUnit(points: readonly number[], start: number): number | undefined {
  let value = 0;
  for (let index = start; index < start + 4; index++) {
    const point = points[index];
    if (point === undefined) return undefined;
    const digit = point >= 48 && point <= 57 ? point - 48
      : point >= 65 && point <= 70 ? point - 55
        : point >= 97 && point <= 102 ? point - 87 : -1;
    if (digit < 0) return undefined;
    value = value * 16 + digit;
  }
  return value;
}

/** Only two adjacent JSON escapes combine; raw or mixed neighbors never do. */
export function scanPointString(points: readonly number[], start: number): {
  points: number[]; next: number;
} {
  const output: number[] = [];
  let position = start + 1;
  while (position < points.length) {
    const point = points[position]!;
    if (point === 34) return { points: output, next: position + 1 };
    if (point < 32) throw new PointSyntaxError("Invalid control character at", position);
    if (point !== 92) {
      output.push(point);
      position++;
      continue;
    }
    const slash = position++;
    const escaped = points[position];
    if (escaped === 117) {
      const high = hexUnit(points, position + 1);
      if (high === undefined) throw new PointSyntaxError("Invalid \\uXXXX escape", position);
      position += 5;
      if (high >= 0xd800 && high <= 0xdbff && points[position] === 92
        && points[position + 1] === 117) {
        const low = hexUnit(points, position + 2);
        if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
          output.push(0x10000 + (high - 0xd800) * 1024 + low - 0xdc00);
          position += 6;
          continue;
        }
      }
      output.push(high);
    } else if (escaped !== undefined && shortEscapes.has(escaped)) {
      output.push(shortEscapes.get(escaped)!);
      position++;
    } else {
      if (escaped === undefined) break;
      throw new PointSyntaxError("Invalid \\escape", slash);
    }
  }
  throw new PointSyntaxError("Unterminated string starting at", start);
}

const asciiEscapes = new Map<number, string>([
  [8, "\\b"], [9, "\\t"], [10, "\\n"], [12, "\\f"], [13, "\\r"], [34, '\\"'], [92, "\\\\"],
]);
const unitEscape = (point: number): string => `\\u${point.toString(16).padStart(4, "0")}`;

export function quotePointString(points: readonly number[]): string {
  const output = ['"'];
  for (const point of points) {
    const escape = asciiEscapes.get(point);
    if (escape !== undefined) output.push(escape);
    else if (point > 0xffff) {
      const scalar = point - 0x10000;
      output.push(unitEscape(0xd800 + (scalar >> 10)), unitEscape(0xdc00 + (scalar & 1023)));
    } else if (point < 32 || point >= 127) output.push(unitEscape(point));
    else output.push(String.fromCharCode(point));
  }
  output.push('"');
  return output.join("");
}
