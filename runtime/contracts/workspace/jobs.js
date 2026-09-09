import { PythonText } from "../python-text.js";
import { PythonObject } from "../python-object.js";
import { get, has, int, string, object, keys, JobsError } from "./values.js";
import { normalizeJobUrl } from "./job-url.js";
export const ingestFields = new Set([
    "url", "source", "sourceId", "role", "company", "location", "workplaceType",
    "employmentType", "compensation", "description", "ats", "priority", "notes", "lastCheckedAt",
]);
export const patchFields = new Set([...ingestFields, "resumeId", "provenance"]);
export const createFields = new Set([...patchFields, "id", "status", "closedOutcome"]);
const recordFields = new Set([...createFields, "normalizedUrl", "legacySources", "revision",
    "createdAt", "updatedAt", "deletedAt"]);
export const statuses = new Set(["saved", "needs_info", "ready", "in_progress", "awaiting_review", "applied", "closed"]);
export function safeId(value) {
    if (value === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || /[\r\n]/.test(value) || value.includes("..")) {
        throw new JobsError("application id contains unsupported characters");
    }
    return value;
}
export function validateInput(value, patch) {
    const input = object(value, patch ? "job patch" : "job input");
    if (patch && input.size === 0 || keys(input).some(key => !(patch ? patchFields : createFields).has(key))) {
        throw new JobsError(`job ${patch ? "patch" : "input"} contains unsupported fields`);
    }
    return input;
}
export function validateJob(key, value) {
    const record = object(value, "job record");
    if (keys(record).some(key => !recordFields.has(key)))
        throw new JobsError("job record contains unsupported fields");
    if (string(get(record, "id")) !== key)
        throw new JobsError("job record id does not match its index");
    safeId(key);
    if (string(get(record, "normalizedUrl")) !== normalizeJobUrl(string(get(record, "url")))) {
        throw new JobsError("job record normalized URL does not match");
    }
    const status = string(get(record, "status"));
    if (!statuses.has(status))
        throw new JobsError("job status is unsupported");
    const outcome = get(record, "closedOutcome");
    if (status === "closed") {
        if (!["rejected", "withdrawn", "expired", "duplicate", "not_interested"].includes(string(outcome))) {
            throw new JobsError("closed job requires a supported outcome");
        }
    }
    else if (outcome !== null)
        throw new JobsError("open job cannot have a closed outcome");
    const priority = has(record, "priority") ? int(get(record, "priority")) : 0n;
    if (priority === null || priority < 0n || priority > 5n)
        throw new JobsError("job priority must be an integer from 0 to 5");
    const revision = int(get(record, "revision"));
    if (revision === null || revision < 1n)
        throw new JobsError("job revision must be a positive integer");
    if (has(record, "provenance"))
        object(get(record, "provenance"), "job provenance");
    const sources = has(record, "legacySources") ? get(record, "legacySources") : [];
    if (!Array.isArray(sources))
        throw new JobsError("job legacySources must be an array");
    for (const value of sources) {
        const source = object(value, "job legacy source");
        if (source.size !== 4 || keys(source).some(key => !["sourceKind", "relativePath", "entryId", "sourceSha256"].includes(key))) {
            throw new JobsError("job legacy source contains unsupported fields");
        }
        if (string(get(source, "sourceKind")) !== "timestamped-search-report")
            throw new JobsError("job legacy source kind is unsupported");
        const path = string(get(source, "relativePath"));
        if (!path || path.includes("/") || !path.startsWith("search-") || !path.endsWith(".md"))
            throw new JobsError("job legacy source path is invalid");
        if (!/^legacy-entry-[0-9a-f]{24}$/.test(string(get(source, "entryId")) ?? ""))
            throw new JobsError("job legacy source entry id is invalid");
        if (!/^[0-9a-f]{64}$/.test(string(get(source, "sourceSha256")) ?? ""))
            throw new JobsError("job legacy source digest is invalid");
    }
    for (const field of recordFields) {
        if (["id", "status", "priority", "revision", "provenance", "legacySources"].includes(field))
            continue;
        const value = get(record, field);
        if (value !== null && !(value instanceof PythonText))
            throw new JobsError(`job record.${field} must be a string`);
    }
    for (const [field, label] of [["createdAt", "creation"], ["updatedAt", "update"]]) {
        if (!string(get(record, field)))
            throw new JobsError(`job record has no ${label} timestamp`);
    }
    return record;
}
export function validateJobsDocument(value) {
    const document = object(value, "jobs");
    if (int(get(document, "schemaVersion")) !== 1n)
        throw new JobsError("jobs schema version is unsupported");
    const jobs = object(get(document, "jobs"), "jobs.jobs");
    object(get(document, "metadata"), "jobs.metadata");
    for (const [key, value] of jobs.entries())
        validateJob(string(key), value);
    return document;
}
export const emptyObject = () => new PythonObject();
