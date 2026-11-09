import { parsePythonJson, PythonJsonError } from "../contracts/raw-json/parser.js";
import { readFileText } from "./read-file.js";
import { requireObject, StoreValidationError } from "./validation.js";
function isReadFailure(error) {
    if (!(error instanceof Error))
        return false;
    const details = error;
    return typeof details.errno === "number"
        || details.code === "ERR_ENCODING_INVALID_ENCODED_DATA";
}
/** Read one object only; caller owns version validation and path security policy. */
export async function readJsonObject(path, label, options) {
    let value;
    try {
        value = parsePythonJson(await readFileText(path), options);
    }
    catch (error) {
        // Preserve the reference's narrow boundary: digit limits and configuration
        // failures remain distinct, rather than becoming generic file-read errors.
        if (!(error instanceof PythonJsonError) && !isReadFailure(error))
            throw error;
        throw new StoreValidationError(`cannot read valid ${label} JSON at ${path}`);
    }
    return requireObject(value, label);
}
