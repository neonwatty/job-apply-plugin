import { PythonText } from "../python-text.js";
import { floatScope } from "./float-scope.js";
import { serializeJsonGraph } from "./json-serialization-core.js";
import { quotePointString } from "./point-text-codec.js";
import type { PythonJson } from "./value.js";

const quote = (value: string): string => quotePointString(PythonText.fromJavaScript(value).codePoints);
const compareKeys = (left: string, right: string): number =>
  PythonText.fromJavaScript(left).compare(PythonText.fromJavaScript(right));

/** Compact, sorted, ensure_ascii spelling without recursive JS calls. */
export function serializePythonScope(value: PythonJson): string {
  return serializeJsonGraph<PythonJson>(value, current => {
    if (current === null) return { kind: "scalar", text: "null" };
    if (typeof current === "boolean") return { kind: "scalar", text: current ? "true" : "false" };
    if (typeof current === "string") return { kind: "scalar", text: quote(current) };
    if (Array.isArray(current)) return { kind: "array", identity: current, items: current };
    if (current instanceof Map) {
      return { kind: "object", identity: current,
        entries: [...current.keys()].sort(compareKeys).map(key => [quote(key), current.get(key)!] as const) };
    }
    return { kind: "scalar", text: current.kind === "int" ? current.value.toString() : floatScope(current.value) };
  }, () => new TypeError("Circular JSON value"));
}
