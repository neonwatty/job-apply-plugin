import type { PythonText } from "../python-text.js";
import type { PythonObject } from "../python-object.js";
import type { NumericAtom } from "./numeric-atom.js";

/** Inert representation; existing Store consumers still use PythonJson. */
export type PythonPointJson = null | boolean | PythonText | NumericAtom
  | PythonPointJson[] | PythonObject<PythonPointJson>;

/** Reviewed diagnostic behavior of captured CPython 3.12/3.13/3.14 profiles. */
export type PythonJsonDiagnosticProfile = "3.12" | "3.13" | "3.14";
export interface PythonPointJsonOptions {
  intMaxStrDigits: number;
  diagnosticProfile: PythonJsonDiagnosticProfile;
}
