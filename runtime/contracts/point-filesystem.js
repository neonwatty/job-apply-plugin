import { PythonText, PythonUnicodeEncodeError } from "./python-text.js";
import { filesystemDecode, filesystemEncode } from "./posix-path-bytes.js";
import { pointContents } from "./raw-json/point-text-codec.js";
/** UTF-8 surrogateescape over explicit Python points; NUL is legal. */
export function filesystemEncodePoint(text) {
    const points = pointContents(text);
    const characters = [];
    for (let index = 0; index < points.length; index++) {
        const point = points[index];
        if (point >= 0xd800 && point <= 0xdfff && (point < 0xdc80 || point > 0xdcff)) {
            let end = index + 1;
            while (end < points.length && points[end] >= 0xd800 && points[end] <= 0xdfff)
                end++;
            // Build the message from trusted contents, then retain the original caller.
            const canonical = PythonText.fromCodePoints(points);
            const error = new PythonUnicodeEncodeError(canonical, index, end);
            Object.defineProperty(error, "object", { value: text });
            throw error;
        }
        characters.push(String.fromCodePoint(point));
    }
    // Only scalars and low escape points survive; no literal high can merge here.
    return filesystemEncode(characters.join(""));
}
/** The legacy decoder emits only scalars or DC80–DCFF, making this projection lossless. */
export function filesystemDecodePoint(bytes) {
    return PythonText.fromJavaScript(filesystemDecode(bytes));
}
