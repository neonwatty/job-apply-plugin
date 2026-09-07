import type { NumericAtom } from "./numeric-atom.js";

/** JSON values with Python integer/float identity and explicit object ordering. */
export type PythonJson =
  | null
  | boolean
  | string
  | NumericAtom
  | PythonJson[]
  | Map<string, PythonJson>;
