import { PythonText } from "../python-text.js";
import { PythonObject } from "../python-object.js";
import { floatScope } from "./float-scope.js";
import { serializeJsonGraph } from "./json-serialization-core.js";
import { pointContents, quotePointString } from "./point-text-codec.js";
const objectEntries = PythonObject.prototype.entries;
function compareKeys(a, b) {
    const left = pointContents(a), right = pointContents(b);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
        if (left[index] !== right[index])
            return left[index] < right[index] ? -1 : 1;
    }
    return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}
export class PythonPointJsonCircularError extends Error {
    constructor() { super("Circular reference detected"); this.name = "ValueError"; }
}
export function serializePythonPointScope(value) {
    return serializeJsonGraph(value, current => {
        if (current === null)
            return { kind: "scalar", text: "null" };
        if (typeof current === "boolean")
            return { kind: "scalar", text: current ? "true" : "false" };
        if (current instanceof PythonText)
            return { kind: "scalar", text: quotePointString(pointContents(current)) };
        if (Array.isArray(current))
            return { kind: "array", identity: current, items: current };
        if (current instanceof PythonObject) {
            return { kind: "object", identity: current,
                entries: [...objectEntries.call(current)].sort(([a], [b]) => compareKeys(a, b))
                    .map(([key, item]) => [quotePointString(pointContents(key)), item]) };
        }
        if (typeof current === "object" && current !== null) {
            if (current.kind === "int" && typeof current.value === "bigint" && typeof current.scope === "string") {
                return { kind: "scalar", text: current.value.toString() };
            }
            if (current.kind === "float" && typeof current.value === "number" && typeof current.scope === "string") {
                return { kind: "scalar", text: floatScope(current.value) };
            }
        }
        throw new TypeError("Expected a point JSON value");
    }, () => new PythonPointJsonCircularError());
}
