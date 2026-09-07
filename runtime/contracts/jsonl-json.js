import { encodePersistedUtf8, iterPersistedJson } from "./persisted-json.js";
/** Sorted json.dumps default separators, ensure_ascii=False, followed by LF. */
export function encodeJsonlJson(value, options) {
    const chunks = [];
    for (const chunk of iterPersistedJson(value, options)) {
        // The reviewed encoder escapes every LF within quoted strings. Actual LF
        // therefore belongs only to indentation, never to a key or string value.
        chunks.push(chunk.replace(/,\n */g, ", ").replace(/\n */g, ""));
    }
    return encodePersistedUtf8(chunks.join("") + "\n");
}
