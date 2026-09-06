import { floatScope } from "./float-scope.js";
import type { PythonJson } from "./value.js";

function quote(value: string): string {
  const output = ['"'];
  const escapes: Record<number, string> = {
    8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r", 34: '\\"', 92: "\\\\",
  };
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (Object.hasOwn(escapes, unit)) output.push(escapes[unit]!);
    else if (unit < 32 || unit >= 127) output.push(`\\u${unit.toString(16).padStart(4, "0")}`);
    else output.push(value[index]!);
  }
  output.push('"');
  return output.join("");
}

function compareKeys(left: string, right: string): number {
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const first = left.codePointAt(a)!;
    const second = right.codePointAt(b)!;
    if (first !== second) return first < second ? -1 : 1;
    a += first > 65535 ? 2 : 1;
    b += second > 65535 ? 2 : 1;
  }
  return a < left.length ? 1 : b < right.length ? -1 : 0;
}

type Action =
  | { kind: "value"; value: PythonJson }
  | { kind: "text"; text: string }
  | { kind: "leave"; container: PythonJson[] | Map<string, PythonJson> };

/** Compact, sorted, ensure_ascii spelling without recursive JS calls. */
export function serializePythonScope(value: PythonJson): string {
  const actions: Action[] = [{ kind: "value", value }];
  const active = new Set<PythonJson[] | Map<string, PythonJson>>();
  const output: string[] = [];
  while (actions.length > 0) {
    const action = actions.pop()!;
    if (action.kind === "text") {
      output.push(action.text);
      continue;
    }
    if (action.kind === "leave") {
      active.delete(action.container);
      continue;
    }
    const current = action.value;
    if (current === null) output.push("null");
    else if (typeof current === "boolean") output.push(current ? "true" : "false");
    else if (typeof current === "string") output.push(quote(current));
    else if (Array.isArray(current) || current instanceof Map) {
      if (active.has(current)) throw new TypeError("Circular JSON value");
      active.add(current);
      actions.push({ kind: "leave", container: current });
      if (Array.isArray(current)) {
        output.push("[");
        actions.push({ kind: "text", text: "]" });
        for (let index = current.length - 1; index >= 0; index -= 1) {
          actions.push({ kind: "value", value: current[index]! });
          if (index > 0) actions.push({ kind: "text", text: "," });
        }
      } else {
        output.push("{");
        actions.push({ kind: "text", text: "}" });
        const keys = [...current.keys()].sort(compareKeys);
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index]!;
          actions.push({ kind: "value", value: current.get(key)! });
          actions.push({ kind: "text", text: `${quote(key)}:` });
          if (index > 0) actions.push({ kind: "text", text: "," });
        }
      }
    } else if (current.kind === "int") output.push(current.value.toString());
    else output.push(floatScope(current.value));
  }
  return output.join("");
}
