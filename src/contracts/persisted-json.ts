import { floatScope } from "./raw-json/float-scope.js";
import type { PythonJson } from "./raw-json/value.js";
import { validatePathProfile } from "./posix-path.js";
import type { PythonPathProfile } from "./posix-path.js";

export interface PersistedJsonOptions {
  pathProfile: PythonPathProfile;
  intMaxStrDigits: number;
}

export class PersistedJsonError extends Error {
  constructor(name: "ValueError" | "UnicodeEncodeError", message: string) {
    super(message);
    this.name = name;
  }
}

export function encodePersistedUtf8(text: string): Buffer {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    const next = text.charCodeAt(index + 1);
    if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) index += 1;
    else throw new PersistedJsonError("UnicodeEncodeError", "surrogates not allowed");
  }
  return Buffer.from(text, "utf8");
}

function quote(text: string): string {
  const escaped: Record<number, string> = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r", 34: '\\"', 92: "\\\\" };
  let result = '"';
  for (const character of text) {
    const unit = character.charCodeAt(0);
    result += escaped[unit] ?? (unit < 32 ? `\\u${unit.toString(16).padStart(4, "0")}` : character);
  }
  return result + '"';
}

function compareKeys(left: string, right: string): number {
  const first = [...left];
  const second = [...right];
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    const difference = first[index]!.codePointAt(0)! - second[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return first.length - second.length;
}

/** Python json.dump(indent=2, sort_keys=True, ensure_ascii=False) text chunks. */
export function* iterPersistedJson(value: PythonJson, options: PersistedJsonOptions): Generator<string> {
  validatePathProfile(options.pathProfile);
  if (!Number.isSafeInteger(options.intMaxStrDigits) || options.intMaxStrDigits < 0
    || options.intMaxStrDigits > 0 && options.intMaxStrDigits < 640) {
    throw new RangeError("intMaxStrDigits must be zero or an integer of at least 640");
  }
  const active = new Set<object>();
  function scalar(item: unknown): string | undefined {
    if (item === null) return "null";
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "string") return quote(item);
    if (typeof item === "object" && item !== null && "kind" in item && "value" in item) {
      if (item.kind === "float" && typeof item.value === "number") return floatScope(item.value);
      if (item.kind === "int" && typeof item.value === "bigint") {
        const result = item.value.toString();
        const count = result.length - (result.startsWith("-") ? 1 : 0);
        if (options.intMaxStrDigits && count > options.intMaxStrDigits) {
          throw new PersistedJsonError("ValueError", "Exceeds the limit for integer string conversion");
        }
        return result;
      }
    }
    return undefined;
  }

  function* encode(item: unknown, depth: number): Generator<string> {
    const primitive = scalar(item);
    if (primitive !== undefined) {
      yield primitive;
      return;
    }
    if (!Array.isArray(item) && !(item instanceof Map)) throw new TypeError("Object is not JSON serializable");
    if (item instanceof Map ? item.size === 0 : item.length === 0) {
      yield item instanceof Map ? "{}" : "[]";
      return;
    }
    if (active.has(item)) throw new PersistedJsonError("ValueError", "Circular reference detected");
    active.add(item);
    const indent = "\n" + "  ".repeat(depth + 1);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        const prefix = (index ? "," : "[") + indent;
        const child = scalar(item[index]);
        if (child !== undefined) yield prefix + child;
        else {
          yield prefix;
          yield* encode(item[index], depth + 1);
        }
      }
      yield "\n" + "  ".repeat(depth);
      yield "]";
    } else {
      yield "{";
      if (options.pathProfile === "3.12") yield indent;
      const keys: unknown[] = [...item.keys()];
      if (!keys.every((key): key is string => typeof key === "string")) {
        throw new TypeError("Persisted JSON object keys must be strings");
      }
      keys.sort(compareKeys);
      for (let index = 0; index < keys.length; index += 1) {
        if (index > 0) yield "," + indent;
        else if (options.pathProfile !== "3.12") yield indent;
        const key = keys[index]!;
        yield quote(key);
        yield ": ";
        yield* encode(item.get(key), depth + 1);
      }
      yield "\n" + "  ".repeat(depth);
      yield "}";
    }
    active.delete(item);
  }
  yield* encode(value, 0);
}
