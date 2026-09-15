import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePythonPointJsonBytes } from '../contracts/raw-json/point-parser.js';
import { validateAccountsDocument } from '../contracts/workspace/accounts.js';
import { validateAnswerSession } from '../contracts/workspace/answer-session-validation.js';
import { validateAnswers } from '../contracts/workspace/answers.js';
import { validateSettingsDocument } from '../contracts/workspace/automation.js';
import { validateCoordinator } from '../contracts/workspace/claims.js';
import { validateExtractionRequests } from '../contracts/workspace/extraction-requests.js';
import { validateExtractions } from '../contracts/workspace/extraction-proposals.js';
import { validateGroups } from '../contracts/workspace/fact-groups.js';
import { validateJobsDocument } from '../contracts/workspace/jobs.js';
import { validateProfile } from '../contracts/workspace/profile.js';
import { validateTrustedFillDocument } from '../contracts/workspace/trusted-fill.js';
import { fromJSON, get, object, set, string, JobsError } from '../contracts/workspace/values.js';
import { validateAccountOperationJournal } from '../contracts/workspace/account-operation.js';
import { validateAnswerJournal } from './native-answer-journal.js';
import { validateClaimJournal } from './native-claim-journal.js';
import { NativeExtractionJournal, validateExtractionJournal, validateExtractionResumes } from './native-extraction-journal.js';
import { NativeClaimHistory } from './native-claim-history.js';
import { atomicWritePointJson } from './point-persistence.js';
const pointOptions = { pathProfile: '3.12', intMaxStrDigits: 4300 };
const schemaVersion = 1;
export function nativeStorePaths(root, legacyProfile) {
    return {
        schemaVersion, root, profile: join(root, 'profile.json'), factGroups: join(root, 'fact-groups.json'),
        answers: join(root, 'answers.json'), jobs: join(root, 'jobs.json'), resumes: join(root, 'resumes.json'),
        resumeExtractionRequests: join(root, 'resume-extraction-requests.json'), history: join(root, 'applications.jsonl'),
        sessions: join(root, 'sessions'), coordinator: join(root, 'coordinator.json'),
        coordinatorJournal: join(root, 'coordinator-journal.json'), automationSettings: join(root, 'automation-settings.json'),
        employerAccounts: join(root, 'employer-accounts.json'), accountOperationJournal: join(root, 'account-operation-journal.json'),
        trustedFill: join(root, 'trusted-fill.json'), autoSubmitPolicy: join(root, 'auto-submit'), legacyProfile,
    };
}
const documentValidators = {
    'profile.json': validateProfile, 'fact-groups.json': validateGroups, 'answers.json': validateAnswers,
    'jobs.json': validateJobsDocument, 'resumes.json': validateExtractionResumes,
    'automation-settings.json': validateSettingsDocument, 'employer-accounts.json': validateAccountsDocument,
    'account-operation-journal.json': value => validateAccountOperationJournal(value),
    'trusted-fill.json': validateTrustedFillDocument, 'resume-extractions.json': validateExtractions,
    'resume-extraction-requests.json': validateExtractionRequests,
    'resume-extraction-journal.json': validateExtractionJournal, 'coordinator.json': validateCoordinator,
    'coordinator-journal.json': value => {
        if (get(value, 'operation') === null)
            return validateAnswerJournal(value);
        try {
            return validateAnswerJournal(value);
        }
        catch {
            return validateClaimJournal(value);
        }
    },
};
function identity(metadata) {
    return { dev: Number(metadata.dev), ino: Number(metadata.ino) };
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function privateOwner(metadata) {
    return process.getuid === undefined || metadata.uid === process.getuid();
}
async function privateDirectory(path, optional) {
    let metadata;
    try {
        metadata = await lstat(path);
    }
    catch (error) {
        if (optional && error.code === 'ENOENT')
            return null;
        throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
        throw new JobsError(`${path} must be a directory without links`);
    if (!privateOwner(metadata) || (metadata.mode & 0o777) !== 0o700)
        throw new JobsError(`${path} must be a private owned directory`);
    return identity(metadata);
}
async function readPrivateFile(path, label, optional = true) {
    let metadata;
    try {
        metadata = await lstat(path);
    }
    catch (error) {
        if (optional && error.code === 'ENOENT')
            return null;
        throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1)
        throw new JobsError(`${label} must be a regular file without links`);
    if (!privateOwner(metadata) || (metadata.mode & 0o777) !== 0o600)
        throw new JobsError(`${label} must be private and owned`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!sameIdentity(identity(metadata), identity(opened)) || !opened.isFile())
            throw new JobsError(`${label} identity changed`);
        const bytes = await handle.readFile();
        const closed = await lstat(path);
        if (!sameIdentity(identity(metadata), identity(closed)))
            throw new JobsError(`${label} identity changed`);
        return bytes;
    }
    finally {
        await handle.close();
    }
}
function document(bytes, label) {
    try {
        return object(parsePythonPointJsonBytes(bytes, { diagnosticProfile: '3.12', intMaxStrDigits: 4300 }), label);
    }
    catch (error) {
        throw error instanceof JobsError ? error : new JobsError(`cannot read valid ${label} JSON`);
    }
}
export class NativeStoreBootstrap {
    root;
    legacyProfile;
    layout;
    clock;
    boundary;
    constructor(root, legacyProfile = join(homedir(), '.claude-job-profile.json'), options = {}) {
        this.root = root;
        this.legacyProfile = legacyProfile;
        this.layout = nativeStorePaths(root, legacyProfile);
        this.clock = options.clock ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
        this.boundary = options.boundary ?? (async () => { });
    }
    paths() { return fromJSON(this.layout); }
    async validateSessions() {
        const directoryIdentity = await privateDirectory(this.layout.sessions, true);
        if (directoryIdentity === null)
            return;
        for (const name of (await readdir(this.layout.sessions)).sort()) {
            if (!name.endsWith('.json'))
                continue;
            const value = validateAnswerSession(document((await readPrivateFile(join(this.layout.sessions, name), 'session', false)), 'session'));
            if (string(get(value, 'applicationId')) !== name.slice(0, -5))
                throw new JobsError('session application id does not match path');
        }
        const closed = await privateDirectory(this.layout.sessions, false);
        if (!sameIdentity(directoryIdentity, closed))
            throw new JobsError('sessions directory identity changed');
    }
    async preflight() {
        const rootIdentity = await privateDirectory(this.root, true);
        if (rootIdentity !== null) {
            for (const [name, validate] of Object.entries(documentValidators)) {
                const bytes = await readPrivateFile(join(this.root, name), name);
                if (bytes !== null)
                    validate(document(bytes, name.replace('.json', '')));
            }
            await this.validateSessions();
            const history = await readPrivateFile(this.layout.history, 'history');
            if (history !== null)
                await new NativeClaimHistory(this.root).read();
            await privateDirectory(join(this.root, 'resume-files'), true);
            const autoSubmit = await privateDirectory(this.layout.autoSubmitPolicy, true);
            void autoSubmit;
        }
        let legacy = null;
        if (await readPrivateFile(this.layout.profile, 'profile') === null) {
            const bytes = await readPrivateFile(this.legacyProfile, 'legacy profile');
            if (bytes !== null)
                legacy = document(bytes, 'legacy profile');
        }
        return { root: rootIdentity, legacy };
    }
    now() {
        const value = this.clock();
        if (!value)
            throw new JobsError('clock returned an invalid value');
        return value;
    }
    async write(name, value) {
        await atomicWritePointJson(join(this.root, name), fromJSON(value), pointOptions);
    }
    async writeDocument(name, value) {
        await atomicWritePointJson(join(this.root, `${name}.json`), value, pointOptions);
    }
    async initialize() {
        const checked = await this.preflight();
        await this.boundary('preflight-complete');
        if (checked.root !== null) {
            const current = await privateDirectory(this.root, false);
            if (!sameIdentity(checked.root, current))
                throw new JobsError('Store root identity changed');
        }
        else {
            await mkdir(this.root, { recursive: true, mode: 0o700 });
            await privateDirectory(this.root, false);
        }
        await mkdir(this.layout.sessions, { recursive: true, mode: 0o700 });
        await privateDirectory(this.layout.sessions, false);
        const resumeFiles = join(this.root, 'resume-files');
        await mkdir(resumeFiles, { recursive: true, mode: 0o700 });
        await privateDirectory(resumeFiles, false);
        const extractionJournal = await readPrivateFile(join(this.root, 'resume-extraction-journal.json'), 'resume-extraction-journal.json');
        if (extractionJournal !== null) {
            const recovery = new NativeExtractionJournal(async () => document((await readPrivateFile(join(this.root, 'resume-extraction-journal.json'), 'resume-extraction-journal.json', false)), 'resume extraction journal'), (name, value) => this.writeDocument(name, value));
            await recovery.recover();
        }
        let migrated = false;
        if (await readPrivateFile(this.layout.profile, 'profile') === null) {
            const createdAt = this.now(), updatedAt = this.now();
            const metadata = { createdAt, updatedAt, revision: 1, factProvenance: {} };
            if (checked.legacy !== null) {
                metadata.migratedFrom = '~/.claude-job-profile.json';
                metadata.migratedAt = this.now();
                migrated = true;
            }
            const profile = object(fromJSON({ schemaVersion, profile: {}, metadata }), 'profile');
            if (checked.legacy !== null)
                set(profile, 'profile', checked.legacy);
            await this.writeDocument('profile', profile);
        }
        const definitions = [
            ['answers.json', 'answers', { redirects: {} }], ['fact-groups.json', 'groups', {}],
            ['jobs.json', 'jobs', {}], ['resumes.json', 'resumes', {}],
        ];
        for (const [name, key, extra] of definitions)
            if (await readPrivateFile(join(this.root, name), name) === null) {
                const now = this.now();
                await this.write(name, { schemaVersion, [key]: {}, ...extra, metadata: { createdAt: now, updatedAt: now } });
            }
        if (await readPrivateFile(this.layout.history, 'history') === null) {
            const history = await open(this.layout.history, 'wx', 0o600);
            try {
                await history.sync();
            }
            finally {
                await history.close();
            }
        }
        return fromJSON({ initialized: true, migratedLegacyProfile: migrated, ...this.layout });
    }
}
function expandUser(path, home) {
    return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}
export function createNativeStoreBootstrap(root, legacyProfile, environment = process.env, home = homedir()) {
    const selectedRoot = root || environment.JOB_APPLY_STORE_DIR || join(home, '.job-apply');
    return new NativeStoreBootstrap(expandUser(selectedRoot, home), expandUser(legacyProfile || join(home, '.claude-job-profile.json'), home));
}
