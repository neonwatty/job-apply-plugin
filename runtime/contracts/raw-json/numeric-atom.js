import { floatScope } from "./float-scope.js";
export class NumericAtomError extends Error {
    reason;
    constructor(reason) {
        super(reason === "syntax" ? "Invalid numeric token" : "Integer digit limit exceeded");
        this.reason = reason;
        this.name = "NumericAtomError";
    }
}
/** Inert compatibility helper. The caller supplies its reference integer limit. */
export function parseNumericAtom(token, options) {
    if (!Number.isSafeInteger(options.intMaxStrDigits) || options.intMaxStrDigits < 0) {
        throw new RangeError("intMaxStrDigits must be a nonnegative safe integer");
    }
    // Comparing the complete match also rejects final newlines (JS $ accepts them).
    const match = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|NaN|-?Infinity)$/.exec(token);
    if (!match || match[0] !== token)
        throw new NumericAtomError("syntax");
    if (/^-?[0-9]+$/.test(token)) {
        const count = token.length - (token.startsWith("-") ? 1 : 0);
        if (options.intMaxStrDigits !== 0 && count > options.intMaxStrDigits) {
            throw new NumericAtomError("integer-digit-limit");
        }
        const value = BigInt(token);
        return { kind: "int", value, scope: value.toString() };
    }
    const value = Number(token);
    return { kind: "float", value, scope: floatScope(value) };
}
