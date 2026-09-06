import { parseNumericAtom } from "./numeric-atom.js";
import type { PythonJson } from "./value.js";

export class PythonJsonError extends Error {
  readonly reason = "syntax" as const;

  constructor(readonly offset: number) {
    super(`Invalid JSON at code-point offset ${offset}`);
    this.name = "PythonJsonError";
  }
}

type Frame =
  | { kind: "array"; value: PythonJson[]; state: "first" | "value" | "comma" }
  | { kind: "object"; value: Map<string, PythonJson>;
      state: "first" | "key" | "colon" | "value" | "comma"; key: string };

/** Inert decoder: iterative traversal deliberately imposes no new nesting limit. */
export function parsePythonJson(
  raw: string,
  options: { intMaxStrDigits: number },
): PythonJson {
  if (!Number.isSafeInteger(options.intMaxStrDigits) || options.intMaxStrDigits < 0) {
    throw new RangeError("intMaxStrDigits must be a nonnegative safe integer");
  }
  let position = 0;
  const frames: Frame[] = [];
  let root: PythonJson = null;
  let hasRoot = false;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|-?Infinity|NaN/y;

  function fail(at = position): never {
    throw new PythonJsonError(Array.from(raw.slice(0, at)).length);
  }

  function skipWhitespace(): void {
    while (position < raw.length && " \t\r\n".includes(raw[position]!)) position += 1;
  }

  function string(): string {
    const start = position;
    position += 1;
    const parts: string[] = [];
    let segment = position;
    while (position < raw.length) {
      const character = raw[position]!;
      if (character === '"') {
        parts.push(raw.slice(segment, position));
        position += 1;
        return parts.join("");
      }
      if (character.charCodeAt(0) < 32) fail();
      if (character !== "\\") {
        position += 1;
        continue;
      }
      parts.push(raw.slice(segment, position));
      const escapeAt = position;
      position += 1;
      const escaped = raw[position];
      const escapes: Record<string, string> = {
        '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
      };
      if (escaped === "u") {
        const hex = raw.slice(position + 1, position + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(position);
        parts.push(String.fromCharCode(Number.parseInt(hex, 16)));
        position += 5;
      } else if (escaped !== undefined && Object.hasOwn(escapes, escaped)) {
        parts.push(escapes[escaped]!);
        position += 1;
      } else {
        fail(escaped === undefined ? start : escapeAt);
      }
      segment = position;
    }
    return fail(start);
  }

  function attach(value: PythonJson): void {
    const parent = frames[frames.length - 1];
    if (!parent) {
      root = value;
      hasRoot = true;
    } else if (parent.kind === "array") {
      parent.value.push(value);
      parent.state = "comma";
    } else {
      parent.value.set(parent.key, value);
      parent.state = "comma";
    }
  }

  function value(): void {
    const character = raw[position];
    if (character === "[") {
      const array: PythonJson[] = [];
      attach(array);
      frames.push({ kind: "array", value: array, state: "first" });
      position += 1;
    } else if (character === "{") {
      const object = new Map<string, PythonJson>();
      attach(object);
      frames.push({ kind: "object", value: object, state: "first", key: "" });
      position += 1;
    } else if (character === '"') {
      attach(string());
    } else {
      for (const [token, literal] of [["null", null], ["true", true], ["false", false]] as const) {
        if (raw.startsWith(token, position)) {
          position += token.length;
          attach(literal);
          return;
        }
      }
      number.lastIndex = position;
      const match = number.exec(raw);
      if (!match) fail();
      position = number.lastIndex;
      attach(parseNumericAtom(match[0], options));
    }
  }

  while (true) {
    skipWhitespace();
    const frame = frames[frames.length - 1];
    if (!frame) {
      if (hasRoot) {
        if (position !== raw.length) fail();
        return root;
      }
      value();
      continue;
    }
    const character = raw[position];
    const closing = frame.kind === "array" ? "]" : "}";
    if ((frame.state === "first" || frame.state === "comma") && character === closing) {
      frames.pop();
      position += 1;
    } else if (frame.state === "comma") {
      if (character !== ",") fail();
      frame.state = frame.kind === "array" ? "value" : "key";
      position += 1;
    } else if (frame.kind === "object" && (frame.state === "first" || frame.state === "key")) {
      if (character !== '"') fail();
      frame.key = string();
      frame.state = "colon";
    } else if (frame.kind === "object" && frame.state === "colon") {
      if (character !== ":") fail();
      frame.state = "value";
      position += 1;
    } else {
      value();
    }
  }
}
