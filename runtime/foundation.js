/** Build sentinel only: no application route or canonical writer uses this. */
export const migrationAuthority = Object.freeze({
    schemaVersion: 1,
    mode: "shadow-only",
    canonicalWriter: "python",
});
