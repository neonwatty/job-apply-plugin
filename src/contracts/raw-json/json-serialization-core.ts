export type JsonShape<V> =
  | { kind: "scalar"; text: string }
  | { kind: "array"; identity: object; items: readonly V[] }
  | { kind: "object"; identity: object; entries: ReadonlyArray<readonly [string, V]> };

type Action<V> = { kind: "value"; value: V } | { kind: "text"; text: string }
  | { kind: "leave"; identity: object };

/** Shared traversal; adapters supply already sorted, quoted object keys. */
export function serializeJsonGraph<V>(value: V, describe: (value: V) => JsonShape<V>,
  circular: () => Error): string {
  const actions: Action<V>[] = [{ kind: "value", value }];
  const active = new Set<object>();
  const output: string[] = [];
  while (actions.length) {
    const action = actions.pop()!;
    if (action.kind === "text") { output.push(action.text); continue; }
    if (action.kind === "leave") { active.delete(action.identity); continue; }
    const shape = describe(action.value);
    if (shape.kind === "scalar") { output.push(shape.text); continue; }
    if (active.has(shape.identity)) throw circular();
    active.add(shape.identity);
    actions.push({ kind: "leave", identity: shape.identity });
    if (shape.kind === "array") {
      output.push("[");
      actions.push({ kind: "text", text: "]" });
      for (let index = shape.items.length - 1; index >= 0; index--) {
        actions.push({ kind: "value", value: shape.items[index]! });
        if (index > 0) actions.push({ kind: "text", text: "," });
      }
    } else {
      output.push("{");
      actions.push({ kind: "text", text: "}" });
      for (let index = shape.entries.length - 1; index >= 0; index--) {
        const [key, item] = shape.entries[index]!;
        actions.push({ kind: "value", value: item });
        actions.push({ kind: "text", text: `${key}:` });
        if (index > 0) actions.push({ kind: "text", text: "," });
      }
    }
  }
  return output.join("");
}
