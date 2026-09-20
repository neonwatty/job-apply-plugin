import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
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
import { validateResumeFacts } from '../contracts/workspace/resume-facts.js';
import { validateTrustedFillDocument } from '../contracts/workspace/trusted-fill.js';
import { fromJSON, get, has, int, object, set, string, JobsError } from '../contracts/workspace/values.js';
import { validateAccountOperationJournal } from '../contracts/workspace/account-operation.js';
import { NativeAnswerJournal, validateAnswerJournal } from './native-answer-journal.js';
import { NativeAnswerResolutionJournal, validateResolutionJournal } from './native-answer-resolution-journal.js';
import { claimOperationKinds, NativeClaimJournal, validateClaimJournal } from './native-claim-journal.js';
import { NativeExtractionJournal, validateExtractionJournal, validateExtractionResumes } from './native-extraction-journal.js';
import { NativeClaimHistory } from './native-claim-history.js';
import { NativeResumeFiles } from './native-resume-files.js';
import { atomicWritePointJson } from './point-persistence.js';
const pointOptions = { pathProfile: '3.12', intMaxStrDigits: 4300 };
const schemaVersion = 1;
function child(root, name) { return root === '/' || root === '//' ? root + name : `${root}/${name}`; }
export function nativeStorePaths(root, legacyProfile) {
    root = pythonPath(root);
    legacyProfile = pythonPath(legacyProfile);
    return {
        schemaVersion, root, profile: child(root, 'profile.json'), factGroups: child(root, 'fact-groups.json'),
        answers: child(root, 'answers.json'), jobs: child(root, 'jobs.json'), resumes: child(root, 'resumes.json'),
        resumeExtractionRequests: child(root, 'resume-extraction-requests.json'), history: child(root, 'applications.jsonl'),
        sessions: child(root, 'sessions'), coordinator: child(root, 'coordinator.json'),
        coordinatorJournal: child(root, 'coordinator-journal.json'), automationSettings: child(root, 'automation-settings.json'),
        employerAccounts: child(root, 'employer-accounts.json'), accountOperationJournal: child(root, 'account-operation-journal.json'),
        trustedFill: child(root, 'trusted-fill.json'), autoSubmitPolicy: child(root, 'auto-submit'), legacyProfile,
    };
}
function validateResumeOperation(document) {
    if (document.size !== 2 || int(get(document, 'schemaVersion')) !== 1n || !has(document, 'operation')) {
        throw new JobsError('resume recovery schema version is unsupported');
    }
    return document;
}
const documentValidators = {
    'profile.json': validateProfile, 'fact-groups.json': validateGroups, 'answers.json': validateAnswers,
    'jobs.json': validateJobsDocument, 'resumes.json': validateExtractionResumes,
    'automation-settings.json': validateSettingsDocument, 'employer-accounts.json': validateAccountsDocument,
    'account-operation-journal.json': value => validateAccountOperationJournal(value),
    'trusted-fill.json': validateTrustedFillDocument, 'resume-extractions.json': validateExtractions,
    'resume-facts.json': validateResumeFacts,
    'resume-extraction-requests.json': validateExtractionRequests,
    'resume-extraction-journal.json': validateExtractionJournal, 'resume-operation.json': validateResumeOperation,
    'coordinator.json': validateCoordinator,
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
/** Production callers must supply `locked` around the complete preflight/recovery transaction. */
export class NativeStoreBootstrap {
    root;
    legacyProfile;
    layout;
    clock;
    boundary;
    locked;
    constructor(root, legacyProfile = join(homedir(), '.claude-job-profile.json'), options = {}) {
        this.root = pythonPath(root);
        this.legacyProfile = pythonPath(legacyProfile);
        this.layout = nativeStorePaths(this.root, this.legacyProfile);
        this.clock = options.clock ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
        this.boundary = options.boundary ?? (async () => { });
        this.locked = options.locked ?? (operation => operation());
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
            let pendingClaim = false;
            const journalBytes = await readPrivateFile(this.layout.coordinatorJournal, 'coordinator-journal.json');
            if (journalBytes !== null) {
                const journal = document(journalBytes, 'coordinator journal'), operation = get(journal, 'operation');
                if (operation === null)
                    validateAnswerJournal(journal);
                else {
                    const kind = string(get(object(operation, 'coordinator operation'), 'kind'));
                    if (kind === 'answer_resolution')
                        validateResolutionJournal(journal);
                    else if (claimOperationKinds.has(kind)) {
                        validateClaimJournal(journal);
                        pendingClaim = true;
                    }
                    else
                        validateAnswerJournal(journal);
                }
            }
            if (history !== null && !pendingClaim)
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
    async readDocument(name) {
        return document((await readPrivateFile(join(this.root, `${name}.json`), `${name}.json`, false)), name);
    }
    async sessions() {
        const result = [];
        for (const name of (await readdir(this.layout.sessions)).sort())
            if (name.endsWith('.json')) {
                result.push(validateAnswerSession(await this.readDocument(`sessions/${name.slice(0, -5)}`)));
            }
        return result;
    }
    async recoverCoordinator() {
        const coordinatorExists = await readPrivateFile(this.layout.coordinator, 'coordinator.json') !== null;
        const journalExists = await readPrivateFile(this.layout.coordinatorJournal, 'coordinator-journal.json') !== null;
        if (!coordinatorExists && !journalExists)
            return;
        if (!coordinatorExists)
            await this.writeDocument('coordinator', object(fromJSON({ schemaVersion: 1, claim: null }), 'coordinator'));
        if (!journalExists)
            await this.writeDocument('coordinator-journal', object(fromJSON({ schemaVersion: 1, operation: null }), 'journal'));
        const coordinator = validateCoordinator(await this.readDocument('coordinator'));
        const journal = await this.readDocument('coordinator-journal'), operation = get(journal, 'operation');
        const history = new NativeClaimHistory(this.root);
        if (operation === null) {
            await history.read();
            return;
        }
        const kind = string(get(object(operation, 'coordinator operation'), 'kind'));
        if (claimOperationKinds.has(kind)) {
            await history.repairPendingTail();
            await new NativeClaimJournal((name, value) => this.writeDocument(name, value), history)
                .recover(journal, validateJobsDocument(await this.readDocument('jobs')));
            return;
        }
        await history.read();
        if (get(coordinator, 'claim') !== null)
            throw new JobsError('answer recovery requires an idle coordinator');
        const sessions = await this.sessions();
        if (kind === 'answer_resolution') {
            await new NativeAnswerResolutionJournal((name, value) => this.writeDocument(name, value))
                .recover(journal, validateJobsDocument(await this.readDocument('jobs')), sessions);
        }
        else {
            await new NativeAnswerJournal((name, value) => this.writeDocument(name, value))
                .recover(journal, validateAnswers(await this.readDocument('answers')), sessions);
        }
    }
    async recoverResumeFiles() {
        const directory = join(this.root, 'resume-files'), names = await readdir(directory);
        if (names.length === 0)
            return;
        const resumeBytes = await readPrivateFile(this.layout.resumes, 'resumes.json');
        let resumes = resumeBytes === null ? object(fromJSON({ schemaVersion: 1, resumes: {}, metadata: {} }), 'resumes')
            : validateExtractionResumes(document(resumeBytes, 'resumes'));
        const journalBytes = await readPrivateFile(join(this.root, 'resume-operation.json'), 'resume-operation.json');
        if (journalBytes !== null) {
            const journal = validateResumeOperation(document(journalBytes, 'resume recovery journal'));
            const operation = get(journal, 'operation');
            await new NativeResumeFiles(this.root).recover(operation === null ? null : object(operation, 'resume recovery operation'), resumes, async (value) => { resumes = validateExtractionResumes(value); await this.writeDocument('resumes', resumes); }, () => this.writeDocument('resume-operation', object(fromJSON({ schemaVersion: 1, operation: null }), 'journal')));
            return;
        }
        const cached = new Map();
        for (const name of names)
            cached.set(name, (await readPrivateFile(join(directory, name), 'resume recovery file', false)));
        for (const name of names)
            if (name.startsWith('.') && name.endsWith('.tmp'))
                await unlink(join(directory, name));
        for (const name of names)
            if (name.startsWith('.browser-upload.') && !name.endsWith('.tmp')) {
                if ((await lstat(join(directory, name))).mtimeMs <= Date.now() - 300_000)
                    await unlink(join(directory, name));
            }
        const records = object(get(resumes, 'resumes'), 'resumes.resumes');
        const referenced = new Set();
        const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
        for (const [, value] of records.entries()) {
            const record = object(value, 'resume record');
            if (string(get(record, 'storageKind')) !== 'managed')
                continue;
            const managed = string(get(record, 'managedFile')), expected = string(get(record, 'digest'));
            referenced.add(managed);
            const quarantines = names.filter(name => name.startsWith(`.${managed}.`) && name.endsWith('.quarantine')).sort();
            let canonical = cached.get(managed);
            if (canonical === undefined || digest(canonical) !== expected) {
                const recovery = quarantines.find(name => digest(cached.get(name)) === expected);
                if (recovery !== undefined) {
                    if (canonical !== undefined)
                        await unlink(join(directory, managed));
                    await rename(join(directory, recovery), join(directory, managed));
                    canonical = cached.get(recovery);
                }
            }
            if (canonical !== undefined && digest(canonical) === expected) {
                for (const name of quarantines)
                    await unlink(join(directory, name)).catch(error => {
                        if (error.code !== 'ENOENT')
                            throw error;
                    });
            }
        }
        for (const name of names)
            if (name.startsWith('.') && name.endsWith('.quarantine')) {
                await unlink(join(directory, name)).catch(error => { if (error.code !== 'ENOENT')
                    throw error; });
            }
        for (const name of names)
            if (!name.startsWith('.') && /\.(?:pdf|docx|txt)$/i.test(name) && !referenced.has(name)) {
                await unlink(join(directory, name)).catch(error => { if (error.code !== 'ENOENT')
                    throw error; });
            }
        const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    async initialize() { return this.locked(() => this.initializeLocked()); }
    async initializeLocked() {
        let checked = await this.preflight();
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
        const confirmed = await this.preflight();
        if (confirmed.root === null || checked.root !== null && !sameIdentity(checked.root, confirmed.root)) {
            throw new JobsError('Store root identity changed');
        }
        checked = confirmed;
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
        await this.recoverResumeFiles();
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
            ['resume-facts.json', 'sets', {}],
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
        await this.recoverCoordinator();
        return fromJSON({ initialized: true, migratedLegacyProfile: migrated, ...this.layout });
    }
}
function expandUser(path, home) {
    const current = `~${userInfo().username}`;
    if (path === '~' || path === current)
        return home;
    if (path.startsWith('~/'))
        return child(home, path.slice(2));
    if (path.startsWith(`${current}/`))
        return child(home, path.slice(current.length + 1));
    return path;
}
function pythonPath(path) {
    const prefix = path.startsWith('//') && !path.startsWith('///') ? '//' : path.startsWith('/') ? '/' : '';
    const parts = path.split('/').filter(part => part !== '' && part !== '.');
    const result = prefix + parts.join('/');
    return result || prefix || '.';
}
export function createNativeStoreBootstrap(root, legacyProfile, environment = process.env, home = homedir(), options = {}) {
    const selectedRoot = root || environment.JOB_APPLY_STORE_DIR || join(home, '.job-apply');
    return new NativeStoreBootstrap(expandUser(selectedRoot, home), expandUser(legacyProfile || join(home, '.claude-job-profile.json'), home), options);
}
