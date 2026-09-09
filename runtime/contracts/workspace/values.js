import { PythonObject } from "../python-object.js";
import { PythonText } from "../python-text.js";
import { parsePythonPointJson } from "../raw-json/point-parser.js";
import { serializePythonPointScope } from "../raw-json/point-serializer.js";
export const text = (value) => PythonText.fromJavaScript(value);
export const integer = (value) => ({ kind: "int", value, scope: value.toString() });
export const get = (value, key) => value.get(text(key), null);
export const has = (value, key) => value.has(text(key));
export const set = (value, key, item) => value.set(text(key), item);
export const copy = (value) => {
    const result = new PythonObject();
    for (const [key, item] of value.entries())
        result.set(key, item);
    return result;
};
export class JobsError extends Error {
}
export function object(value, label) {
    if (!(value instanceof PythonObject))
        throw new JobsError(`${label} must be an object`);
    return value;
}
export function string(value) {
    if (!(value instanceof PythonText))
        return null;
    return value.codePoints.map(point => String.fromCodePoint(point)).join("");
}
export function int(value) {
    return value !== null && typeof value === "object" && "kind" in value && value.kind === "int"
        ? value.value : null;
}
export const parse = (value) => parsePythonPointJson(text(value), {
    diagnosticProfile: "3.12", intMaxStrDigits: 4300,
});
export const serialize = serializePythonPointScope;
export function truth(value) {
    if (value === null || value === false)
        return false;
    if (value instanceof PythonText)
        return value.codePoints.length !== 0;
    if (value instanceof PythonObject)
        return value.size !== 0;
    if (Array.isArray(value))
        return value.length !== 0;
    if (typeof value === "object" && "kind" in value)
        return value.value != 0;
    return true;
}
export function fromJSON(value) {
    return parse(JSON.stringify(value));
}
export function keys(value) {
    return value.entries().map(([key]) => string(key));
}
export function same(left, right) {
    // Python numeric equality includes integer/float and boolean equality.
    const numeric = (value) => typeof value === "boolean" ? BigInt(value)
        : value !== null && typeof value === "object" && "kind" in value ? value.value : null;
    const a = numeric(left), b = numeric(right);
    if (a !== null && b !== null)
        return a == b;
    if (left instanceof PythonObject && right instanceof PythonObject) {
        return left.size === right.size && left.entries().every(([key, item]) => right.has(key) && same(item, right.get(key)));
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((item, index) => same(item, right[index]));
    }
    return serialize(left) === serialize(right);
}
