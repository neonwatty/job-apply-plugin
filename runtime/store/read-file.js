import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
/** Raw compatibility leaf: follows links, without initialization or mode repair. */
export async function readFileText(path) {
    const bytes = await readFile(path);
    // Python's explicit utf-8 text reader rejects malformed bytes and retains BOM.
    // ignoreBOM means treat the BOM as text, rather than silently stripping it.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.replace(/\r\n?/g, "\n");
}
