// Frozen against scripts/job_apply_store/constants.py by reference tests.
const SCHEMA_VERSION = 1n;
export class StoreValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "StoreValidationError";
    }
}
export function requireObject(value, label) {
    if (!(value instanceof Map)) {
        throw new StoreValidationError(`${label} must be a JSON object`);
    }
    return value;
}
export function validateVersion(document, label) {
    const version = document.get("schemaVersion");
    if (version === null || typeof version !== "object" ||
        Array.isArray(version) || version instanceof Map || version.kind !== "int") {
        throw new StoreValidationError(`${label} has no valid schemaVersion`);
    }
    if (version.value > SCHEMA_VERSION) {
        throw new StoreValidationError(`${label} uses unsupported future schemaVersion ${version.value}`);
    }
    if (version.value !== SCHEMA_VERSION) {
        throw new StoreValidationError(`${label} uses unsupported schemaVersion ${version.value}`);
    }
}
