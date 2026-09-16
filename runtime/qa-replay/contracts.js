import { lstat, readFile } from 'node:fs/promises';
export class ReplayError extends Error {
}
export const scenarios = new Set(['ashby-complete-profile', 'complete-profile', 'greenhouse-complete-profile', 'lever-complete-profile', 'linkedin-screening']);
export const platforms = { ashby: 'Ashby', greenhouse: 'Greenhouse', lever: 'Lever',
    'linkedin-easy-apply': 'LinkedIn Easy Apply' };
export const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const runIdentifier = /^qa-run-20[0-9]{6}-[a-f0-9]{8}$/;
export const token = /^[a-f0-9]{64}$/;
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exact(value, keys) {
    return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function validateFixture(value) {
    if (!record(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !identifier.test(value.id)
        || typeof value.platformFamily !== 'string' || !record(value.oracle) || value.oracle.finalActionActivations !== 0
        || !Array.isArray(value.steps) || value.steps.length < 1)
        throw new ReplayError('invalid fixture package');
    const ids = new Set(), controls = new Set();
    for (const raw of value.steps) {
        if (!record(raw) || typeof raw.id !== 'string' || !identifier.test(raw.id) || ids.has(raw.id)
            || !['form', 'review'].includes(String(raw.kind)) || typeof raw.title !== 'string' || !Array.isArray(raw.controls))
            throw new ReplayError('invalid fixture package');
        ids.add(raw.id);
        for (const item of raw.controls) {
            if (!record(item) || typeof item.id !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(item.id) || controls.has(item.id)
                || typeof item.kind !== 'string' || typeof item.role !== 'string' || typeof item.label !== 'string' || typeof item.required !== 'boolean')
                throw new ReplayError('invalid fixture package');
            controls.add(item.id);
        }
    }
    if (value.steps.filter(raw => record(raw) && raw.kind === 'review').length !== 1)
        throw new ReplayError('invalid fixture package');
    return value;
}
export async function readJson(path, diagnostic, limit = 1024 * 1024) {
    try {
        const info = await lstat(path, { bigint: false });
        if (!info.isFile() || info.size > limit)
            throw new Error();
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        throw new ReplayError(diagnostic);
    }
}
export function validateState(value, runId, runRoot) {
    const keys = ['fixtureId', 'scenarioId', 'url', 'storeRoot', 'fixturePath', 'routeToken', 'shutdownToken', 'lifecycleNonce', 'createdAt'];
    if (!record(value) || !exact(value, keys) || keys.some(key => typeof value[key] !== 'string') || !identifier.test(String(value.fixtureId))
        || !scenarios.has(String(value.scenarioId)) || !token.test(String(value.routeToken)) || !token.test(String(value.shutdownToken))
        || !token.test(String(value.lifecycleNonce)) || !runIdentifier.test(runId)
        || value.storeRoot !== `${runRoot}/store` || value.fixturePath !== `${runRoot}/fixture.json`)
        throw new ReplayError('invalid run state');
    return value;
}
export function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (record(value))
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
