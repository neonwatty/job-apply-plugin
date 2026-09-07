import { PythonObject } from "./python-object.js";
import { PythonText } from "./python-text.js";

const nativeEntries = Map.prototype.entries;
const objectEntries = PythonObject.prototype.entries;
const contentKey = PythonText.prototype.contentKey;
const fromJavaScript = PythonText.fromJavaScript;
const codePoints = Object.getOwnPropertyDescriptor(PythonText.prototype, "codePoints")!.get!;
const CHUNK_POINTS = 4096;

/** Shallow ingress: source references inside values are deliberately not rewired. */
export function fromLegacyMap<V>(source: ReadonlyMap<string, V>): PythonObject<V> {
  const result = new PythonObject<V>();
  for (const [key, value] of nativeEntries.call(source)) {
    if (typeof key !== "string") throw new TypeError("Legacy Map keys must be strings");
    result.set(fromJavaScript(key), value);
  }
  return result;
}

/** Shallow egress; reject unrepresentable codepoint keys before exposing a Map. */
export function toLegacyMap<V>(source: PythonObject<V>): Map<string, V> {
  const converted: Array<[string, V]> = [];
  for (const [key, value] of objectEntries.call(source)) {
    const points: readonly number[] = codePoints.call(key);
    const chunks: string[] = [];
    for (let offset = 0; offset < points.length; offset += CHUNK_POINTS) {
      chunks.push(String.fromCodePoint(...points.slice(offset, offset + CHUNK_POINTS)));
    }
    const text = chunks.join("");
    if (contentKey.call(fromJavaScript(text)) !== contentKey.call(key)) {
      throw new TypeError("PythonObject key cannot be represented losslessly in a JavaScript Map");
    }
    converted.push([text, value as V]);
  }
  return new Map(converted);
}
