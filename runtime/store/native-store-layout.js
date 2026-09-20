import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePythonPointJsonBytes } from '../contracts/raw-json/point-parser.js';
import { get, int, object, string, JobsError } from '../contracts/workspace/values.js';
export const nativeAttemptPidName = '.job-apply-attempt.pid';
export const nativeAttemptPidPendingName = nativeAttemptPidName + '.pending';
export const nativeFixtureMarkerName = '.native-jobs-fixture';
export const nativeCloneMarkerName = '.native-store-clone';
export const nativePolicyTreeName = 'auto-submit';
export const nativeFixtureMarker = '{"mode":"native-jobs-fixture","version":12}\n';
export const nativeStoreRequiredEntries = [
    'automation-settings.json', 'employer-accounts.json', 'account-operation-journal.json',
    'trusted-fill.json', '.store.lock', 'jobs.json', 'profile.json', 'resumes.json',
    'fact-groups.json', 'answers.json', 'resume-operation.json', 'resume-files',
    'resume-extractions.json', 'resume-extraction-requests.json',
    'resume-extraction-journal.json', 'sessions', 'applications.jsonl',
    'coordinator.json', 'coordinator-journal.json',
];
export const nativeStoreAllowedEntries = new Set([
    ...nativeStoreRequiredEntries, nativeFixtureMarkerName, nativeCloneMarkerName, nativeAttemptPidName, nativeAttemptPidPendingName,
    nativePolicyTreeName, 'resume-facts.json',
]);
export function nativeCloneTrees(bytes) {
    let marker;
    try {
        marker = object(parsePythonPointJsonBytes(bytes, { diagnosticProfile: '3.12', intMaxStrDigits: 4300 }), 'clone marker');
    }
    catch {
        throw new JobsError('native Store clone marker is invalid');
    }
    const sourceTree = string(get(marker, 'sourceTree'));
    const candidateTree = string(get(marker, 'candidateTree'));
    if (marker.size !== 4 || string(get(marker, 'mode')) !== 'canonical-store-clone'
        || int(get(marker, 'version')) !== 2n || !/^sha256:[0-9a-f]{64}$/.test(sourceTree ?? '')
        || !/^sha256:[0-9a-f]{64}$/.test(candidateTree ?? '')) {
        throw new JobsError('native Store clone marker is invalid');
    }
    return { sourceTree: sourceTree, candidateTree: candidateTree };
}
export function validateNativeStoreMarker(name, bytes) {
    if (name === nativeFixtureMarkerName) {
        if (bytes.toString('utf8') === nativeFixtureMarker)
            return 'fixture';
        throw new JobsError('native Store is not an explicitly initialized synthetic fixture');
    }
    if (name !== nativeCloneMarkerName)
        throw new JobsError('native Store ownership marker is invalid');
    nativeCloneTrees(bytes);
    return 'clone';
}
/** Optional runtime metadata is bounded and private; process liveness is not Store authority. */
async function validatePidFile(root, name, incomplete) {
    let handle;
    try {
        handle = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw new JobsError('native attempt PID is unavailable');
    }
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
            || (metadata.mode & 0o777) !== 0o600 || metadata.size > 21) {
            throw new JobsError('native attempt PID must be private, owned and bounded');
        }
        const bytes = await handle.readFile();
        const contents = bytes.toString('latin1');
        const valid = incomplete ? /^(?:[1-9][0-9]{0,19}\n?)?$/.test(contents) : /^[1-9][0-9]{0,19}\n$/.test(contents);
        if (!valid)
            throw new JobsError('native attempt PID is invalid');
    }
    finally {
        await handle.close();
    }
}
export async function validateNativeAttemptPid(root) {
    await validatePidFile(root, nativeAttemptPidName, false);
    // A killed publisher may leave any prefix of the PID in its private staging file.
    // This is disposable metadata, never a claim or a reason to prevent recovery.
    await validatePidFile(root, nativeAttemptPidPendingName, true);
}
export async function validateNativeStoreMetadata(root, name, bytes) {
    validateNativeStoreMarker(name, bytes);
    await validateNativeAttemptPid(root);
}
