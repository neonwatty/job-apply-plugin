import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { emptyAccountOperationJournal } from '../contracts/workspace/account-operation.js';
import { fromJSON, JobsError } from '../contracts/workspace/values.js';
import { initialAutomationDocuments } from './native-automation.js';
import { nativeFixtureMarker, nativeFixtureMarkerName } from './native-store-layout.js';
import { atomicWritePointJson } from './point-persistence.js';
const pointOptions = { pathProfile: '3.12', intMaxStrDigits: 4300 };
/** Creates a NEW synthetic root only. Never adopts or initializes an existing Store. */
export async function initializeJobsFixture(root) {
    if (!isAbsolute(root) || root !== resolve(root))
        throw new JobsError('fixture root must be an absolute normalized path');
    await mkdir(root, { mode: 0o700 });
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
    await mkdir(join(root, 'resume-files'), { mode: 0o700 });
    await chmod(join(root, 'resume-files'), 0o700);
    await mkdir(join(root, 'sessions'), { mode: 0o700 });
    await atomicWritePointJson(join(root, 'coordinator.json'), fromJSON({ schemaVersion: 1, claim: null }), pointOptions);
    await atomicWritePointJson(join(root, 'coordinator-journal.json'), fromJSON({ schemaVersion: 1, operation: null }), pointOptions);
    const history = await open(join(root, 'applications.jsonl'), 'wx', 0o600);
    await history.sync();
    await history.close();
    const lock = await open(join(root, '.store.lock'), 'wx', 0o600);
    await lock.close();
    for (const [name, document] of Object.entries(initialAutomationDocuments(now))) {
        await atomicWritePointJson(join(root, `${name}.json`), document, pointOptions);
    }
    await atomicWritePointJson(join(root, 'account-operation-journal.json'), emptyAccountOperationJournal(), pointOptions);
    await atomicWritePointJson(join(root, 'trusted-fill.json'), fromJSON({ schemaVersion: 1, approvals: {},
        metadata: { createdAt: now, updatedAt: now } }), pointOptions);
    const handle = await open(join(root, nativeFixtureMarkerName), 'wx', 0o600);
    try {
        await handle.writeFile(nativeFixtureMarker);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    const directory = await open(root, constants.O_RDONLY);
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
