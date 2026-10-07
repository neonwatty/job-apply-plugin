import { fromJSON, get, integer, object, set, string } from '../../contracts/workspace/values.js';
import { revision, snapshot } from '../../harness/validation.js';
function exactRevision(document, key) {
    const value = string(get(document, key));
    if (value !== null)
        set(document, key, integer(BigInt(revision(value, 'invalid_arguments'))));
}
/** Decode only known revision fields. Applicant strings and other session values stay strings. */
export function claimSessionInput(raw) {
    const session = object(fromJSON(snapshot(raw)), 'session');
    exactRevision(session, 'attemptRevision');
    const handoff = get(session, 'browserHandoff');
    if (handoff !== null)
        exactRevision(object(handoff, 'browser handoff'), 'revision');
    const rawPacket = get(session, 'readinessInput');
    if (rawPacket === null)
        return session;
    const packet = object(rawPacket, 'readiness input');
    for (const key of ['attemptRevision', 'expectedObservationRevision'])
        exactRevision(packet, key);
    for (const key of ['observedForm', 'observation', 'formManifest']) {
        const value = get(packet, key);
        if (value === null)
            continue;
        const document = object(value, 'readiness document');
        exactRevision(document, 'observationRevision');
        if (key === 'observation') {
            const controls = get(document, 'controls');
            if (Array.isArray(controls))
                for (const control of controls)
                    exactRevision(object(control, 'observed control'), 'observationRevision');
        }
    }
    return session;
}
