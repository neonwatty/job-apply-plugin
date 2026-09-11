import { PythonObject } from "../contracts/python-object.js";
import { strip } from "../contracts/workspace/job-url.js";
import { copy, get, set, string, same, fromJSON, JobsError } from "../contracts/workspace/values.js";
export function origin(value) {
    if (value !== "human" && value !== "agent")
        throw new JobsError("job origin must be human or agent");
    return value;
}
export const nonempty = (value) => value !== null && (string(value) === null || !!strip(string(value)));
export function mayUpdate(record, provenance, field) {
    const authored = get(provenance, `/${field}`);
    const value = authored instanceof PythonObject ? string(get(authored, "origin")) : null;
    return ["human", "agent", "migration"].includes(value) ? value === "agent" : !nonempty(get(record, field));
}
export function protectMigration(current, replacement) {
    for (const [path, value] of [...current.entries(), ...replacement.entries()]) {
        if (value instanceof PythonObject && string(get(value, "origin")) === "migration"
            && !same(current.get(path, null), replacement.get(path, null))) {
            throw new JobsError("migration provenance is reserved for guided legacy imports");
        }
    }
}
export function stamp(provenance, fields, author, record, now) {
    const result = copy(provenance);
    const observationSource = strip(string(get(record, "source")) ?? "").toLowerCase() || "manual";
    for (const field of fields)
        set(result, `/${field}`, fromJSON({ origin: author, observationSource, updatedAt: now }));
    return result;
}
/** Only guided legacy imports can refresh previously imported or empty fields. */
export function migrationMayUpdate(record, provenance, field) {
    if (!nonempty(get(record, field)))
        return true;
    const authored = get(provenance, `/${field}`);
    return authored instanceof PythonObject && string(get(authored, "origin")) === "migration";
}
