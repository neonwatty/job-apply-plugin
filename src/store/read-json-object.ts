import { parsePythonJson, PythonJsonError } from "../contracts/raw-json/parser.js";
import type { PythonJson } from "../contracts/raw-json/value.js";
import { readFileText } from "./read-file.js";
import { requireObject, StoreValidationError } from "./validation.js";

function isReadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as Error & { errno?: unknown; code?: unknown };
  return typeof details.errno === "number"
    || details.code === "ERR_ENCODING_INVALID_ENCODED_DATA";
}

/** Read one object only; caller owns version validation and path security policy. */
export async function readJsonObject(
  path: string,
  label: string,
  options: { intMaxStrDigits: number },
): Promise<Map<string, PythonJson>> {
  let value: PythonJson;
  try {
    value = parsePythonJson(await readFileText(path), options);
  } catch (error) {
    // Preserve the reference's narrow boundary: digit limits and configuration
    // failures remain distinct, rather than becoming generic file-read errors.
    if (!(error instanceof PythonJsonError) && !isReadFailure(error)) throw error;
    throw new StoreValidationError(`cannot read valid ${label} JSON at ${path}`);
  }
  return requireObject(value, label);
}
