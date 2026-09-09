import { PythonText, PythonUnicodeEncodeError } from "../contracts/python-text.js";
import { PythonObject } from "../contracts/python-object.js";
import { pointContents } from "../contracts/raw-json/point-text-codec.js";
import { floatScope } from "../contracts/raw-json/float-scope.js";
import { iterPersistence } from "../contracts/persisted-json-core.js";
import { describeException, exceptionFacts, linkPointContext, registerUnicodeException } from "../contracts/persistence-exception.js";
import { createNativeAtomicWriteIOFor } from "./private-filesystem.js";
import { atomicWriteJsonFor } from "./atomic-write-json.js";
import { appendHistoryEventFor } from "./jsonl-history.js";
import { createNativeJsonlHistoryIO } from "./jsonl-history-io.js";
const objectEntries = PythonObject.prototype.entries;
const objectSize = Object.getOwnPropertyDescriptor(PythonObject.prototype, "size").get;
const encodeText = PythonText.prototype.encodeUtf8;
const text = {
    literal: ascii => PythonText.fromJavaScript(ascii),
    concat(parts) {
        const points = [];
        for (const part of parts)
            for (const point of pointContents(part))
                points.push(point);
        return PythonText.fromCodePoints(points);
    },
};
const escapes = {
    8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r", 34: '\\"', 92: "\\\\",
};
function quote(value) {
    const points = [34];
    for (const point of pointContents(value)) {
        const escape = escapes[point] ?? (point < 32 ? `\\u${point.toString(16).padStart(4, "0")}` : undefined);
        if (escape !== undefined) {
            for (const character of escape)
                points.push(character.charCodeAt(0));
        }
        else
            points.push(point);
    }
    points.push(34);
    return PythonText.fromCodePoints(points);
}
function compareKeys(a, b) {
    const left = pointContents(a), right = pointContents(b);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
        if (left[index] !== right[index])
            return left[index] < right[index] ? -1 : 1;
    }
    return left.length - right.length;
}
function valueError(message) {
    const error = new Error(message);
    error.name = "ValueError";
    throw error;
}
function adapter(options) {
    return {
        scalar(value) {
            if (value === null)
                return text.literal("null");
            if (typeof value === "boolean")
                return text.literal(value ? "true" : "false");
            if (value instanceof PythonText)
                return quote(value);
            if (Array.isArray(value) || value instanceof PythonObject)
                return undefined;
            if (typeof value === "object" && value !== null && "kind" in value && "value" in value) {
                if (value.kind === "float" && typeof value.value === "number")
                    return text.literal(floatScope(value.value));
                if (value.kind === "int" && typeof value.value === "bigint") {
                    const decimal = value.value.toString();
                    const digits = decimal.length - (decimal.startsWith("-") ? 1 : 0);
                    if (options.intMaxStrDigits && digits > options.intMaxStrDigits) {
                        return valueError(`Exceeds the limit (${options.intMaxStrDigits} digits) for integer string conversion; use sys.set_int_max_str_digits() to increase the limit`);
                    }
                    return text.literal(decimal);
                }
            }
            return undefined;
        },
        array: value => Array.isArray(value) ? { identity: value, items: value } : undefined,
        object: value => value instanceof PythonObject ? {
            identity: value,
            empty: objectSize.call(value) === 0,
            sortedEntries() {
                return [...objectEntries.call(value)].sort(([a], [b]) => compareKeys(a, b))
                    .map(([key, item]) => ({ key: quote(key), readValue: () => item }));
            },
        } : undefined,
        unsupported() { throw new TypeError("Expected a point JSON value"); },
        circular() { return valueError("Circular reference detected"); },
    };
}
/** Explicit codepoints, including adjacent surrogate points, survive every chunk. */
export function* iterPersistedPointJson(value, options) {
    yield* iterPersistence(value, options, text, adapter(options));
}
/** Encode trusted captured contents; report the original caller's text identity. */
export function encodePersistedPointUtf8(value) {
    const canonical = PythonText.fromCodePoints(pointContents(value));
    try {
        return encodeText.call(canonical);
    }
    catch (error) {
        if (error instanceof PythonUnicodeEncodeError) {
            Object.defineProperty(error, "object", { value, enumerable: true, writable: true, configurable: true });
            registerUnicodeException(error, {
                encoding: error.encoding, reason: error.reason, object: value,
                start: error.start, end: error.end,
            });
        }
        throw error;
    }
}
/** Finish serialization and LF assembly before the one strict UTF8 operation. */
export function encodePointJsonlJson(value, options) {
    const chunks = [...iterPersistence(value, options, text, adapter(options), true)];
    chunks.push(text.literal("\n"));
    return encodePersistedPointUtf8(text.concat(chunks));
}
export function createNativePointAtomicWriteIO(profile) {
    return createNativeAtomicWriteIOFor(profile, encodePersistedPointUtf8, linkPointContext);
}
export async function atomicWritePointJson(path, payload, options, io = createNativePointAtomicWriteIO(options.pathProfile)) {
    return atomicWriteJsonFor(path, iterPersistedPointJson(payload, options), text.literal("\n"), io, linkPointContext);
}
export async function appendPointHistoryEvent(path, event, options) {
    return appendHistoryEventFor(path, event, item => options.isIdempotent(item), () => encodePointJsonlJson(event, options.serialization), () => options.io ?? createNativeJsonlHistoryIO(options.serialization.pathProfile), linkPointContext);
}
export function pointExceptionFacts(error) {
    const facts = exceptionFacts(error);
    if (facts.unicode !== null)
        pointContents(facts.unicode.object);
    return facts;
}
export function describePointException(error, descriptor) {
    describeException(error, descriptor);
}
