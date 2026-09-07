import { PythonText } from "../python-text.js";
import { PythonObject } from "../python-object.js";
import { decodePythonJsonBytes } from "../python-json-bytes.js";
import { NumericAtomError, parseNumericAtom } from "./numeric-atom.js";
import { parsePointDocument } from "./point-parser-core.js";
import { pointContents, PointSyntaxError } from "./point-text-codec.js";
import type { PythonPointJson, PythonPointJsonOptions } from "./point-value.js";

export class PythonPointJsonDecodeError extends Error {
  readonly lineno: number;
  readonly colno: number;
  constructor(readonly msg: string, readonly doc: PythonText, readonly pos: number) {
    let line = 1, lastLine = -1;
    for (let index = 0; index < pos; index++) {
      if (pointContents(doc)[index] === 10) { line++; lastLine = index; }
    }
    const column = pos - lastLine;
    super(`${msg}: line ${line} column ${column} (char ${pos})`);
    this.name = "JSONDecodeError";
    this.lineno = line;
    this.colno = column;
  }
}

export class PythonPointJsonValueError extends Error {
  constructor(message: string) { super(message); this.name = "ValueError"; }
}

function validateOptions(options: PythonPointJsonOptions): void {
  if (options === null || typeof options !== "object") throw new TypeError("Expected point JSON options");
  if (!Number.isSafeInteger(options.intMaxStrDigits) || options.intMaxStrDigits < 0) {
    throw new RangeError("intMaxStrDigits must be a nonnegative safe integer");
  }
  if (!["3.12", "3.13", "3.14"].includes(options.diagnosticProfile)) {
    throw new TypeError("Expected a reviewed JSON diagnostic profile");
  }
}

export function parsePythonPointJson(document: PythonText, options: PythonPointJsonOptions): PythonPointJson {
  validateOptions(options);
  const points = pointContents(document);
  try {
    return parsePointDocument<PythonPointJson, PythonText>(points, {
      text: points => PythonText.fromCodePoints(points),
      key: points => PythonText.fromCodePoints(points), literal: value => value,
      number: token => {
        try { return parseNumericAtom(token, options); }
        catch (error) {
          if (!(error instanceof NumericAtomError) || error.reason !== "integer-digit-limit") throw error;
          const digits = token.length - (token.startsWith("-") ? 1 : 0);
          throw new PythonPointJsonValueError(`Exceeds the limit (${options.intMaxStrDigits} digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`);
        }
      },
      array: () => {
        const value: PythonPointJson[] = [];
        return { value, append: item => { value.push(item); } };
      },
      object: () => {
        const value = new PythonObject<PythonPointJson>();
        return { value, set: (key, item) => { value.set(key, item); } };
      },
    });
  } catch (error) {
    if (!(error instanceof PointSyntaxError)) throw error;
    if (error.trailing && options.diagnosticProfile !== "3.12") {
      throw new PythonPointJsonDecodeError(`Illegal trailing comma before end of ${error.trailing.kind}`,
        document, error.trailing.comma);
    }
    throw new PythonPointJsonDecodeError(error.reason, document, error.position);
  }
}

export function parsePythonPointJsonBytes(bytes: Buffer, options: PythonPointJsonOptions): PythonPointJson {
  validateOptions(options);
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Expected a Buffer");
  return parsePythonPointJson(decodePythonJsonBytes(bytes), options);
}
