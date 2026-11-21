import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { emptyAccountOperationJournal } from '../contracts/workspace/account-operation.js';
import { fromJSON, JobsError } from '../contracts/workspace/values.js';
import { syncDirectory } from './directory-sync.js';
import { initialAutomationDocuments } from './native-automation.js';
import { nativeFixtureMarker, nativeFixtureMarkerName } from './native-store-layout.js';
import { atomicWritePointJson } from './point-persistence.js';
import { ensureWindowsPrivateDirectory, openWindowsStoreFile } from './windows-store.js';
const pointOptions = { pathProfile: '3.12', intMaxStrDigits: 4300 };
const windows = process.platform === 'win32';
const createFile = (path) => windows
    ? openWindowsStoreFile(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL)
    : open(path, 'wx', 0o600);
const createDirectory = (path) => windows ? ensureWindowsPrivateDirectory(path, false) : mkdir(path, { mode: 0o700 });
/** Creates a NEW synthetic root only. Never adopts or initializes an existing Store. */
export async function initializeJobsFixture(root) {
    if (!isAbsolute(root) || root !== resolve(root))
        throw new JobsError('fixture root must be an absolute normalized path');
    await createDirectory(root);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const name of ['jobs', 'profile', 'resumes', 'fact-groups', 'answers']) {
        const payload = name === 'fact-groups' ? { schemaVersion: 1, groups: {}, metadata: { createdAt: now, updatedAt: now } }
            : name === 'answers' ? { schemaVersion: 1, answers: {}, redirects: {}, metadata: { updatedAt: now } }
                : name === 'profile' ? { schemaVersion: 1, profile: {}, metadata: { createdAt: now, updatedAt: now, revision: 1, factProvenance: {} } }
                    : { schemaVersion: 1, [name]: {}, metadata: { updatedAt: now } };
        await atomicWritePointJson(join(root, `${name}.json`), fromJSON(payload), pointOptions);
    }
    await atomicWritePointJson(join(root, 'resume-operation.json'), fromJSON({ schemaVersion: 1, operation: null }), pointOptions);
    for (const [name, key] of [['resume-extractions', 'proposals'], ['resume-extraction-requests', 'requests']]) {
        await atomicWritePointJson(join(root, `${name}.json`), fromJSON({ schemaVersion: 1, [key]: {},
            metadata: { createdAt: now, updatedAt: now } }), pointOptions);
    }
    await atomicWritePointJson(join(root, 'resume-extraction-journal.json'), fromJSON({ schemaVersion: 1, operation: null }), pointOptions);
    await createDirectory(join(root, 'resume-files'));
    if (!windows)
        await chmod(join(root, 'resume-files'), 0o700);
    await createDirectory(join(root, 'sessions'));
    await atomicWritePointJson(join(root, 'coordinator.json'), fromJSON({ schemaVersion: 1, claim: null }), pointOptions);
    await atomicWritePointJson(join(root, 'coordinator-journal.json'), fromJSON({ schemaVersion: 1, operation: null }), pointOptions);
    const history = await createFile(join(root, 'applications.jsonl'));
    try {
        await history.sync();
    }
    finally {
        await history.close();
    }
    const lock = await createFile(join(root, '.store.lock'));
    await lock.close();
    for (const [name, document] of Object.entries(initialAutomationDocuments(now))) {
        await atomicWritePointJson(join(root, `${name}.json`), document, pointOptions);
    }
    await atomicWritePointJson(join(root, 'account-operation-journal.json'), emptyAccountOperationJournal(), pointOptions);
    await atomicWritePointJson(join(root, 'trusted-fill.json'), fromJSON({ schemaVersion: 1, approvals: {},
        metadata: { createdAt: now, updatedAt: now } }), pointOptions);
    const handle = await createFile(join(root, nativeFixtureMarkerName));
    try {
        await handle.writeFile(nativeFixtureMarker);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await syncDirectory(root);
}
