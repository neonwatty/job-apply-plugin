import { PythonObject } from "../contracts/python-object.js";
import { strip } from "../contracts/workspace/job-url.js";
import { copy, get, set, string, same, fromJSON, JobsError } from "../contracts/workspace/values.js";
import type { Document, Value } from "../contracts/workspace/values.js";

export type Origin = "human" | "agent";
export function origin(value: string): Origin {
  if (value !== "human" && value !== "agent") throw new JobsError("job origin must be human or agent");
  return value;
}
export const nonempty = (value: Value): boolean => value !== null && (string(value) === null || !!strip(string(value)!));
export function mayUpdate(record: Document, provenance: Document, field: string): boolean {
  const authored = get(provenance, `/${field}`);
  const value = authored instanceof PythonObject ? string(get(authored, "origin")) : null;
  return ["human", "agent", "migration"].includes(value!) ? value === "agent" : !nonempty(get(record, field));
}
export function protectMigration(current: Document, replacement: Document): void {
  for (const [path, value] of [...current.entries(), ...replacement.entries()]) {
    if (value instanceof PythonObject && string(get(value, "origin")) === "migration"
      && !same(current.get(path, null), replacement.get(path, null))) {
      throw new JobsError("migration provenance is reserved for guided legacy imports");
    }
  }
}
export function stamp(provenance: Document, fields: Iterable<string>, author: Origin | "migration", record: Document, now: string): Document {
  const result = copy(provenance);
  const observationSource = strip(string(get(record, "source")) ?? "").toLowerCase() || "manual";
  for (const field of fields) set(result, `/${field}`, fromJSON({ origin: author, observationSource, updatedAt: now }));
  return result;
}

/** Only guided legacy imports can refresh previously imported or empty fields. */
export function migrationMayUpdate(record: Document, provenance: Document, field: string): boolean {
  if (!nonempty(get(record, field))) return true;
  const authored = get(provenance, `/${field}`);
  return authored instanceof PythonObject && string(get(authored, "origin")) === "migration";
}
