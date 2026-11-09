/** Shared traversal; adapters supply already sorted, quoted object keys. */
export function serializeJsonGraph(value, describe, circular) {
    const actions = [{ kind: "value", value }];
    const active = new Set();
    const output = [];
    while (actions.length) {
        const action = actions.pop();
        if (action.kind === "text") {
            output.push(action.text);
            continue;
        }
        if (action.kind === "leave") {
            active.delete(action.identity);
            continue;
        }
        const shape = describe(action.value);
        if (shape.kind === "scalar") {
            output.push(shape.text);
            continue;
        }
        if (active.has(shape.identity))
            throw circular();
        active.add(shape.identity);
        actions.push({ kind: "leave", identity: shape.identity });
        if (shape.kind === "array") {
            output.push("[");
            actions.push({ kind: "text", text: "]" });
            for (let index = shape.items.length - 1; index >= 0; index--) {
                actions.push({ kind: "value", value: shape.items[index] });
                if (index > 0)
                    actions.push({ kind: "text", text: "," });
            }
        }
        else {
            output.push("{");
            actions.push({ kind: "text", text: "}" });
            for (let index = shape.entries.length - 1; index >= 0; index--) {
                const [key, item] = shape.entries[index];
                actions.push({ kind: "value", value: item });
                actions.push({ kind: "text", text: `${key}:` });
                if (index > 0)
                    actions.push({ kind: "text", text: "," });
            }
        }
    }
    return output.join("");
}
