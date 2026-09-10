import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { fields, matches, member, positive, requireCondition as check } from './answer-session-fields.js';
import { get, object, parse, same, set, string, integer, fromJSON, JobsError } from './values.js';
const kindByRole = { textbox: 'text', combobox: 'selection', radiogroup: 'selection', checkbox: 'toggle', file: 'upload' };
const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function controlsOf(fixture) {
    const steps = get(fixture, 'steps');
    check(Array.isArray(steps), 'invalid fixture steps');
    return steps.flatMap(step => {
        const controls = get(object(step, 'step'), 'controls');
        check(Array.isArray(controls), 'invalid fixture controls');
        return controls.map(item => object(item, 'control'));
    });
}
function validateObservation(observation, fixture, controls) {
    check(fields(observation, ['schemaVersion', 'platformFamily', 'observationRevision', 'adapterState', 'uploadCapability', 'controls', 'validationErrorControlIds', 'finalControlState'], true), 'invalid observation fields');
    check(positive(get(observation, 'schemaVersion')) && same(get(observation, 'schemaVersion'), integer(1n)), 'invalid observation version');
    check(same(get(observation, 'platformFamily'), get(fixture, 'platformFamily')) && positive(get(observation, 'observationRevision')), 'invalid observation identity');
    check(member(get(observation, 'adapterState'), ['accessible', 'inaccessible']), 'invalid adapter state');
    check(member(get(observation, 'uploadCapability'), ['available', 'external-runtime-unavailable', 'not-required']), 'invalid upload capability');
    check(member(get(observation, 'finalControlState'), ['available', 'unavailable', 'inaccessible', 'activated']), 'invalid final state');
    const raw = get(observation, 'controls');
    check(Array.isArray(raw), 'invalid controls');
    const observed = raw.map(item => object(item, 'observed control'));
    const known = new Map(controls.map(item => [string(get(item, 'id')), item]));
    const seen = new Set();
    for (const item of observed) {
        check(fields(item, ['controlId', 'kind', 'state', 'observationRevision'], true), 'invalid observed control fields');
        const id = string(get(item, 'controlId'));
        check(id !== null && known.has(id) && !seen.has(id), 'invalid observed identity');
        seen.add(id);
        const kind = kindByRole[string(get(known.get(id), 'role'))];
        check(kind !== undefined && string(get(item, 'kind')) === kind, 'invalid control kind');
        check(member(get(item, 'state'), [kind === 'upload' ? 'accepted' : 'complete', 'missing', 'rejected', 'unresolved', 'inaccessible']), 'invalid control state');
        check(positive(get(item, 'observationRevision')), 'invalid control revision');
    }
    const errors = get(observation, 'validationErrorControlIds');
    check(Array.isArray(errors), 'invalid validation errors');
    const ids = errors.map(string);
    check(ids.every(id => id !== null && known.has(id)) && new Set(ids).size === ids.length, 'invalid validation identities');
    check(ids.every((id, index) => index === 0 || ids[index - 1] < id), 'unsorted validation identities');
    return observed;
}
/** Recompute only from an exact bundled fixture and closed, current observation input. */
export function recomputeClaimReadiness(raw, attempt, ats) {
    let packet;
    try {
        packet = object(raw, 'readiness input');
    }
    catch {
        throw new JobsError('readiness input must be a JSON object');
    }
    check(fields(packet, ['attemptRevision', 'evidenceKind', 'fixture', 'observation', 'expectedObservationRevision', 'formManifest'], true), 'readiness input contains unsupported fields');
    check(same(get(packet, 'attemptRevision'), attempt), 'readiness input is not bound to the current attempt');
    check(member(get(packet, 'evidenceKind'), ['agent_attested_current_attempt', 'repository_replay']), 'readiness evidence kind is unsupported');
    try {
        const fixture = object(get(packet, 'fixture'), 'readiness fixture');
        check(matches(get(fixture, 'id'), /^[a-z0-9][a-z0-9-]{0,127}$/u), 'invalid fixture id');
        const trusted = parse(readFileSync(new URL(`../../../qa/fixtures/${string(get(fixture, 'id'))}/fixture.json`, import.meta.url), 'utf8'));
        check(canonicalJson(fixture) === canonicalJson(trusted), 'fixture differs from bundled definition');
        check(!string(ats) || same(get(fixture, 'platformFamily'), ats), 'fixture ATS mismatch');
        const controls = controlsOf(fixture), required = controls.filter(item => get(item, 'required') === true);
        check(required.length > 0, 'fixture has no required control');
        const revision = get(packet, 'expectedObservationRevision');
        check(positive(revision), 'invalid expected revision');
        const ids = required.map(item => string(get(item, 'id'))).sort();
        const fingerprint = `sha256:${digest(fromJSON({ platformFamily: string(get(fixture, 'platformFamily')), requiredControlIds: ids }))}`;
        const manifest = object(fromJSON({ schemaVersion: 1, platformFamily: string(get(fixture, 'platformFamily')), requiredControlIds: ids, controlSetFingerprint: fingerprint, complete: true }), 'manifest');
        set(manifest, 'observationRevision', revision);
        check(same(get(packet, 'formManifest'), manifest), 'form manifest mismatch');
        const observation = object(get(packet, 'observation'), 'observation');
        const observed = validateObservation(observation, fixture, controls);
        const byId = new Map(observed.map(item => [string(get(item, 'controlId')), item]));
        const missing = required.filter(item => !byId.has(string(get(item, 'id'))));
        const present = required.flatMap(item => {
            const value = byId.get(string(get(item, 'id')));
            return value ? [value] : [];
        });
        const stale = present.filter(item => !same(get(item, 'observationRevision'), revision));
        const incomplete = present.filter(item => string(get(item, 'state')) !== (string(get(item, 'kind')) === 'upload' ? 'accepted' : 'complete'));
        const requiredUploads = new Set(required.filter(item => string(get(item, 'role')) === 'file').map(item => string(get(item, 'id'))));
        const missingUpload = missing.some(item => requiredUploads.has(string(get(item, 'id')))) || incomplete.some(item => string(get(item, 'kind')) === 'upload' && string(get(item, 'state')) === 'missing');
        const assertions = {
            'observation-current': same(get(observation, 'observationRevision'), revision) && stale.length === 0,
            'adapter-accessible': string(get(observation, 'adapterState')) === 'accessible',
            'required-controls-complete': missing.length + stale.length + incomplete.length === 0,
            'required-uploads-accepted': !missing.some(item => requiredUploads.has(string(get(item, 'id')))) && ![...stale, ...incomplete].some(item => requiredUploads.has(string(get(item, 'controlId')))),
            'validation-clear': get(observation, 'validationErrorControlIds').length === 0,
            'final-control-available': string(get(observation, 'finalControlState')) === 'available',
            'final-action-untouched': string(get(observation, 'finalControlState')) !== 'activated',
        };
        const blockers = new Set();
        if (!assertions['observation-current'])
            blockers.add('readiness-evidence-stale');
        if (!assertions['adapter-accessible'])
            blockers.add('form-observation-inaccessible');
        if (missing.length)
            blockers.add('required-control-evidence-missing');
        if (missingUpload)
            blockers.add('required-upload-missing');
        for (const item of incomplete) {
            const state = string(get(item, 'state')), upload = string(get(item, 'kind')) === 'upload';
            if (state === 'rejected')
                blockers.add(upload ? 'required-upload-rejected' : 'required-control-rejected');
            else if (state === 'unresolved')
                blockers.add('required-control-unresolved');
            else if (state === 'inaccessible')
                blockers.add('required-control-inaccessible');
            else if (state === 'missing' && !upload)
                blockers.add('required-control-incomplete');
        }
        if (!assertions['validation-clear'])
            blockers.add('validation-error-present');
        const final = string(get(observation, 'finalControlState'));
        if (final === 'activated')
            blockers.add('final-action-activated');
        else if (final === 'inaccessible')
            blockers.add('final-control-inaccessible');
        else if (final === 'unavailable')
            blockers.add('final-control-unavailable');
        const fallback = missingUpload && string(get(observation, 'uploadCapability')) === 'external-runtime-unavailable' ? 'owner-upload-required' : null;
        if (fallback)
            blockers.add('external-upload-capability-unavailable');
        const result = object(fromJSON({ status: Object.values(assertions).every(Boolean) ? 'ready' : 'blocked',
            assertions: Object.fromEntries(Object.entries(assertions).map(([key, passed]) => [key, passed ? 'passed' : 'failed'])),
            blockerCodes: [...blockers].sort(), fallbackCode: fallback, controlSetFingerprint: fingerprint, requiredControlCount: ids.length }), 'readiness');
        set(result, 'attemptRevision', attempt);
        set(result, 'observationRevision', get(observation, 'observationRevision'));
        return set(result, 'evidenceKind', get(packet, 'evidenceKind'));
    }
    catch {
        throw new JobsError('readiness evidence is invalid');
    }
}
