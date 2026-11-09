import { floatScope } from "./raw-json/float-scope.js";
import { iterPersistence } from "./persisted-json-core.js";
export class PersistedJsonError extends Error {
    constructor(name, message) {
        super(message);
        this.name = name;
    }
}
export function encodePersistedUtf8(text) {
    for (let index = 0; index < text.length; index += 1) {
        const unit = text.charCodeAt(index);
        if (unit < 0xd800 || unit > 0xdfff)
            continue;
        const next = text.charCodeAt(index + 1);
        if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
            index += 1;
        else
            throw new PersistedJsonError("UnicodeEncodeError", "surrogates not allowed");
    }
    return Buffer.from(text, "utf8");
}
function quote(text) {
    const escaped = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r", 34: '\\"', 92: "\\\\" };
    let result = '"';
    for (const character of text) {
        const unit = character.charCodeAt(0);
        result += escaped[unit] ?? (unit < 32 ? `\\u${unit.toString(16).padStart(4, "0")}` : character);
    }
    return result + '"';
}
function compareKeys(left, right) {
    const first = [...left];
    const second = [...right];
    for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
        const difference = first[index].codePointAt(0) - second[index].codePointAt(0);
        if (difference)
            return difference;
    }
    return first.length - second.length;
}
/** Python json.dump(indent=2, sort_keys=True, ensure_ascii=False) text chunks. */
export function* iterPersistedJson(value, options) {
    function scalar(item) {
        if (item === null)
            return "null";
        if (typeof item === "boolean")
            return item ? "true" : "false";
        if (typeof item === "string")
            return quote(item);
        if (typeof item === "object" && item !== null && "kind" in item && "value" in item) {
            if (item.kind === "float" && typeof item.value === "number")
                return floatScope(item.value);
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
    yield* iterPersistence(value, options, {
        literal: ascii => ascii,
        concat: parts => parts.join(""),
    }, {
        scalar,
        array: item => Array.isArray(item) ? { identity: item, items: item } : undefined,
        object: item => item instanceof Map ? {
            identity: item,
            empty: item.size === 0,
            sortedEntries() {
                const keys = [...item.keys()];
                if (!keys.every((key) => typeof key === "string")) {
                    throw new TypeError("Persisted JSON object keys must be strings");
                }
                keys.sort(compareKeys);
                return keys.map(key => ({ key: quote(key), readValue: () => item.get(key) }));
            },
        } : undefined,
        unsupported() { throw new TypeError("Object is not JSON serializable"); },
        circular() { throw new PersistedJsonError("ValueError", "Circular reference detected"); },
    });
}
