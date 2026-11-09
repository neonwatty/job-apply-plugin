import { PointSyntaxError, scanPointString } from "./point-text-codec.js";

export interface PointBuilder<V, K> {
  text(points: readonly number[]): V;
  key(points: readonly number[]): K;
  number(token: string): V;
  literal(value: null | boolean): V;
  array(): { value: V; append(value: V): void };
  object(): { value: V; set(key: K, value: V): void };
}

type Frame<V, K> =
  | { kind: "array"; state: "first" | "value" | "comma";
      comma: number; append(value: V): void }
  | { kind: "object"; state: "first" | "key" | "colon" | "value" | "comma";
      comma: number; key?: K; set(key: K, value: V): void };

const numericPrefix = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|-?Infinity|NaN)/;
const numericCharacters = new Set(Array.from("0123456789-+.eEInfinityNaN", c => c.codePointAt(0)!));

/** The sole JSON grammar engine. Builders preserve their own value representation. */
export function parsePointDocument<V, K>(points: readonly number[], builder: PointBuilder<V, K>): V {
  let position = 0;
  const frames: Frame<V, K>[] = [];
  let result: { value: V } | undefined;
  function fail(reason: string, at = position): never { throw new PointSyntaxError(reason, at); }
  function whitespace(): void {
    while ([32, 9, 13, 10].includes(points[position]!)) position++;
  }
  function string(): number[] {
    const scanned = scanPointString(points, position);
    position = scanned.next;
    return scanned.points;
  }
  function attach(value: V): void {
    const parent = frames.at(-1);
    if (!parent) result = { value };
    else if (parent.kind === "array") {
      parent.append(value);
      parent.state = "comma";
    } else {
      // A key is assigned by the key state before value can be entered.
      parent.set(parent.key!, value);
      parent.state = "comma";
    }
  }
  function value(): void {
    const character = points[position];
    if (character === 91) {
      const array = builder.array();
      attach(array.value);
      frames.push({ kind: "array", append: array.append, state: "first", comma: -1 });
      position++;
    } else if (character === 123) {
      const object = builder.object();
      attach(object.value);
      frames.push({ kind: "object", set: object.set, state: "first", comma: -1 });
      position++;
    } else if (character === 34) attach(builder.text(string()));
    else {
      for (const [token, literal] of [["null", null], ["true", true], ["false", false]] as const) {
        if (Array.from(token).every((c, index) => points[position + index] === c.charCodeAt(0))) {
          position += token.length;
          attach(builder.literal(literal));
          return;
        }
      }
      const token: string[] = [];
      let cursor = position;
      while (numericCharacters.has(points[cursor]!)) token.push(String.fromCharCode(points[cursor++]!));
      const match = numericPrefix.exec(token.join(""));
      if (!match) fail("Expecting value");
      position += match[0].length;
      attach(builder.number(match[0]));
    }
  }
  if (points[0] === 0xfeff) fail("Unexpected UTF-8 BOM (decode using utf-8-sig)");
  while (true) {
    whitespace();
    const frame = frames.at(-1);
    if (!frame) {
      if (result) {
        if (position !== points.length) fail("Extra data");
        return result.value;
      }
      value();
      continue;
    }
    const character = points[position];
    const closing = frame.kind === "array" ? 93 : 125;
    if ((frame.state === "first" || frame.state === "comma") && character === closing) {
      frames.pop();
      position++;
    } else if (frame.state === "comma") {
      if (character !== 44) fail("Expecting ',' delimiter");
      frame.comma = position++;
      frame.state = frame.kind === "array" ? "value" : "key";
    } else if (character === closing && frame.comma >= 0
      && (frame.state === "value" && frame.kind === "array" || frame.state === "key")) {
      throw new PointSyntaxError(frame.kind === "array" ? "Expecting value"
        : "Expecting property name enclosed in double quotes", position,
      { kind: frame.kind, comma: frame.comma });
    } else if (frame.kind === "object" && (frame.state === "first" || frame.state === "key")) {
      if (character !== 34) fail("Expecting property name enclosed in double quotes");
      frame.key = builder.key(string());
      frame.state = "colon";
    } else if (frame.kind === "object" && frame.state === "colon") {
      if (character !== 58) fail("Expecting ':' delimiter");
      frame.state = "value";
      position++;
    } else value();
  }
}
