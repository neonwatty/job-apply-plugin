import { parseNumericAtom } from "./numeric-atom.js";
export class PythonJsonError extends Error {
    offset;
    reason = "syntax";
    constructor(offset) {
        super(`Invalid JSON at code-point offset ${offset}`);
        this.offset = offset;
        this.name = "PythonJsonError";
    }
}
/** Inert decoder: iterative traversal deliberately imposes no new nesting limit. */
export function parsePythonJson(raw, options) {
    if (!Number.isSafeInteger(options.intMaxStrDigits) || options.intMaxStrDigits < 0) {
        throw new RangeError("intMaxStrDigits must be a nonnegative safe integer");
    }
    let position = 0;
    const frames = [];
    let root = null;
    let hasRoot = false;
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|-?Infinity|NaN/y;
    function fail(at = position) {
        throw new PythonJsonError(Array.from(raw.slice(0, at)).length);
    }
    function skipWhitespace() {
        while (position < raw.length && " \t\r\n".includes(raw[position]))
            position += 1;
    }
    function string() {
        const start = position;
        position += 1;
        const parts = [];
        let segment = position;
        while (position < raw.length) {
            const character = raw[position];
            if (character === '"') {
                parts.push(raw.slice(segment, position));
                position += 1;
                return parts.join("");
            }
            if (character.charCodeAt(0) < 32)
                fail();
            if (character !== "\\") {
                position += 1;
                continue;
            }
            parts.push(raw.slice(segment, position));
            const escapeAt = position;
            position += 1;
            const escaped = raw[position];
            const escapes = {
                '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
            };
            if (escaped === "u") {
                const hex = raw.slice(position + 1, position + 5);
                if (!/^[0-9a-fA-F]{4}$/.test(hex))
                    fail(position);
                parts.push(String.fromCharCode(Number.parseInt(hex, 16)));
                position += 5;
            }
            else if (escaped !== undefined && Object.hasOwn(escapes, escaped)) {
                parts.push(escapes[escaped]);
                position += 1;
            }
            else {
                fail(escaped === undefined ? start : escapeAt);
            }
            segment = position;
        }
        return fail(start);
    }
    function attach(value) {
        const parent = frames[frames.length - 1];
        if (!parent) {
            root = value;
            hasRoot = true;
        }
        else if (parent.kind === "array") {
            parent.value.push(value);
            parent.state = "comma";
        }
        else {
            parent.value.set(parent.key, value);
            parent.state = "comma";
        }
    }
    function value() {
        const character = raw[position];
        if (character === "[") {
            const array = [];
            attach(array);
            frames.push({ kind: "array", value: array, state: "first" });
            position += 1;
        }
        else if (character === "{") {
            const object = new Map();
            attach(object);
            frames.push({ kind: "object", value: object, state: "first", key: "" });
            position += 1;
        }
        else if (character === '"') {
            attach(string());
        }
        else {
            for (const [token, literal] of [["null", null], ["true", true], ["false", false]]) {
                if (raw.startsWith(token, position)) {
                    position += token.length;
                    attach(literal);
                    return;
                }
            }
            number.lastIndex = position;
            const match = number.exec(raw);
            if (!match)
                fail();
            position = number.lastIndex;
            attach(parseNumericAtom(match[0], options));
        }
    }
    while (true) {
        skipWhitespace();
        const frame = frames[frames.length - 1];
        if (!frame) {
            if (hasRoot) {
                if (position !== raw.length)
                    fail();
                return root;
            }
            value();
            continue;
        }
        const character = raw[position];
        const closing = frame.kind === "array" ? "]" : "}";
        if ((frame.state === "first" || frame.state === "comma") && character === closing) {
            frames.pop();
            position += 1;
        }
        else if (frame.state === "comma") {
            if (character !== ",")
                fail();
            frame.state = frame.kind === "array" ? "value" : "key";
            position += 1;
        }
        else if (frame.kind === "object" && (frame.state === "first" || frame.state === "key")) {
            if (character !== '"')
                fail();
            frame.key = string();
            frame.state = "colon";
        }
        else if (frame.kind === "object" && frame.state === "colon") {
            if (character !== ":")
                fail();
            frame.state = "value";
            position += 1;
        }
        else {
            value();
        }
    }
}
