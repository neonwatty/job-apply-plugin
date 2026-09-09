const contexts = new WeakMap();
const descriptors = new WeakMap();
const unicodeFacts = new WeakMap();
function requireError(error) {
    if (!(error instanceof Error))
        throw new TypeError("Expected an Error");
}
/** Retained legacy projection: implicit cleanup context occupies Error.cause. */
export const linkLegacyContext = (error, previous) => {
    if (error instanceof Error && previous !== undefined && error !== previous && error.cause === undefined) {
        error.cause = previous;
    }
    return error;
};
/** Match Python's removal of a context back-edge when an exception is reused. */
export const linkPointContext = (error, previous) => {
    if (!(error instanceof Error) || previous === undefined || error === previous)
        return error;
    let cursor = previous;
    const seen = new Set();
    while (cursor instanceof Error && !seen.has(cursor)) {
        seen.add(cursor);
        const next = contexts.get(cursor);
        if (next === error) {
            contexts.delete(cursor);
            break;
        }
        cursor = next;
    }
    contexts.set(error, previous);
    return error;
};
/** Closed descriptors cannot supply implicit context or replace caller errors. */
export function describeException(error, descriptor) {
    requireError(error);
    if (typeof descriptor !== "object" || descriptor === null
        || ![Object.prototype, null].includes(Object.getPrototypeOf(descriptor))) {
        throw new TypeError("Expected an exception descriptor");
    }
    const copy = {};
    for (const key of Reflect.ownKeys(descriptor)) {
        if (key !== "cause" && key !== "suppressContext")
            throw new TypeError("Unknown exception descriptor field");
        const property = Object.getOwnPropertyDescriptor(descriptor, key);
        if (!Object.hasOwn(property, "value"))
            throw new TypeError("Exception descriptors require data properties");
        if (key === "suppressContext") {
            if (typeof property.value !== "boolean")
                throw new TypeError("suppressContext must be a boolean");
            copy.suppressContext = property.value;
        }
        else
            copy.cause = property.value;
    }
    descriptors.set(error, Object.freeze(copy));
}
/** Only the point encoder registers failures it created from trusted contents. */
export function registerUnicodeException(error, unicode) {
    unicodeFacts.set(error, Object.freeze({ ...unicode }));
}
export function exceptionFacts(error) {
    requireError(error);
    const descriptor = descriptors.get(error);
    const hasCause = descriptor !== undefined && Object.hasOwn(descriptor, "cause");
    const cause = (hasCause ? descriptor.cause : error.cause) ?? null;
    const unicode = unicodeFacts.get(error);
    return Object.freeze({
        name: error.name,
        message: error.message,
        errno: "errno" in error && typeof error.errno === "number" ? Math.abs(error.errno) : null,
        cause,
        context: contexts.get(error) ?? null,
        suppressContext: descriptor?.suppressContext ?? (hasCause || cause !== null),
        unicode: unicode === undefined ? null : Object.freeze({ ...unicode }),
    });
}
