import { PythonText } from "../python-text.js";
import { parseNumericAtom } from "./numeric-atom.js";
import { parsePointDocument } from "./point-parser-core.js";
import { PointSyntaxError } from "./point-text-codec.js";
export class PythonJsonError extends Error {
    offset;
    reason = "syntax";
    constructor(offset) {
        super(`Invalid JSON at code-point offset ${offset}`);
        this.offset = offset;
        this.name = "PythonJsonError";
    }
}
/** Deliberate legacy UTF16 projection, never a general rich-value conversion. */
function legacyText(points) {
    return points.map(point => String.fromCodePoint(point)).join("");
}
/** Inert decoder: iterative traversal deliberately imposes no new nesting limit. */
export function parsePythonJson(raw, options) {
    if (!Number.isSafeInteger(options.intMaxStrDigits) || options.intMaxStrDigits < 0) {
        throw new RangeError("intMaxStrDigits must be a nonnegative safe integer");
    }
    try {
        return parsePointDocument(PythonText.fromJavaScript(raw).codePoints, {
            text: legacyText, key: legacyText, literal: value => value,
            number: token => parseNumericAtom(token, options),
            array: () => {
                const value = [];
                return { value, append: item => { value.push(item); } };
            },
            object: () => {
                const value = new Map();
                return { value, set: (key, item) => { value.set(key, item); } };
            },
        });
    }
    catch (error) {
        if (error instanceof PointSyntaxError)
            throw new PythonJsonError(error.position);
        throw error;
    }
}
