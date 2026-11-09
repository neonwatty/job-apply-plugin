import { PythonText } from "./python-text.js";
import { decodePythonUtf8 } from "./python-utf8-decode.js";
import { decodePythonUtf16 } from "./python-utf16-decode.js";
import { decodePythonUtf32 } from "./python-utf32-decode.js";
export { PythonUnicodeDecodeError } from "./python-byte-errors.js";
function requireBuffer(bytes) {
    if (!Buffer.isBuffer(bytes) || !ArrayBuffer.isView(bytes))
        throw new TypeError("Expected a Buffer");
}
export function detectPythonJsonEncoding(bytes) {
    requireBuffer(bytes);
    if (bytes.length >= 4 && ((bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
        || (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0)))
        return "utf-32";
    if (bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff)
        || (bytes[0] === 0xff && bytes[1] === 0xfe)))
        return "utf-16";
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        return "utf-8-sig";
    if (bytes.length >= 4) {
        if (bytes[0] === 0)
            return bytes[1] ? "utf-16-be" : "utf-32-be";
        if (bytes[1] === 0)
            return bytes[2] || bytes[3] ? "utf-16-le" : "utf-32-le";
    }
    else if (bytes.length === 2) {
        if (bytes[0] === 0)
            return "utf-16-be";
        if (bytes[1] === 0)
            return "utf-16-le";
    }
    return "utf-8";
}
export function decodePythonJsonBytes(input) {
    requireBuffer(input);
    const bytes = Buffer.from(input);
    const encoding = detectPythonJsonEncoding(bytes);
    let points;
    switch (encoding) {
        case "utf-8":
            points = decodePythonUtf8(bytes);
            break;
        case "utf-8-sig":
            points = decodePythonUtf8(bytes.subarray(3));
            break;
        case "utf-16":
            points = decodePythonUtf16(bytes, 2, bytes[0] === 0xff);
            break;
        case "utf-16-le":
            points = decodePythonUtf16(bytes, 0, true);
            break;
        case "utf-16-be":
            points = decodePythonUtf16(bytes, 0, false);
            break;
        case "utf-32":
            points = decodePythonUtf32(bytes, 4, bytes[0] === 0xff);
            break;
        case "utf-32-le":
            points = decodePythonUtf32(bytes, 0, true);
            break;
        case "utf-32-be":
            points = decodePythonUtf32(bytes, 0, false);
            break;
    }
    return PythonText.fromCodePoints(points);
}
