import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rm, utimes } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { emptyAccountOperationJournal } from '../contracts/workspace/account-operation.js';
import { fromJSON } from '../contracts/workspace/values.js';
import { JobsError } from '../contracts/workspace/values.js';
import { initialAutomationDocuments } from './native-automation.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { atomicWritePointJson } from './point-persistence.js';
import { nativeCloneMarkerName, nativePolicyTreeName, nativeStoreRequiredEntries } from './native-store-layout.js';
import { copyNativePolicyTree, updateNativePolicyDigest, withNativePolicyTree } from './native-policy-tree.js';
const sourceFiles = new Set([...nativeStoreRequiredEntries.filter(name => name !== 'resume-operation.json'), nativePolicyTreeName, 'resume-facts.json']);
const coreFiles = ['.store.lock', 'jobs.json', 'profile.json', 'resumes.json', 'fact-groups.json',
    'answers.json', 'applications.jsonl', 'resume-files', 'sessions'];
const directories = new Set(['resume-files', 'sessions']);
const options = { pathProfile: '3.12', intMaxStrDigits: 4300 };
async function privateDirectory(path, label) {
    const canonical = await realpath(path).catch(() => null);
    const metadata = await lstat(path).catch(() => null);
    if (canonical !== path || !metadata?.isDirectory() || metadata.isSymbolicLink()
        || metadata.uid !== process.getuid?.() || metadata.mode & 0o077)
        throw new JobsError(`${label} must be private and owned`);
}
async function privateBytes(path, limit = 32 * 1024 * 1024) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid())
            || before.mode & 63n || before.size > BigInt(limit))
            throw new JobsError('canonical clone source file is unsupported');
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
            throw new JobsError('canonical clone source changed');
        return bytes;
    }
    finally {
        await handle.close();
    }
}
async function writePrivate(path, bytes) {
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function copyDirectory(source, target, digest) {
    await mkdir(target, { mode: 0o700 });
    await chmod(target, 0o700);
    const names = (await readdir(source)).sort();
    for (const name of names) {
        if (!/^[A-Za-z0-9._-]{1,200}$/.test(name) || name === '.' || name === '..') {
            throw new JobsError('canonical clone directory entry is unsupported');
        }
        const path = join(source, name), metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink())
            throw new JobsError('canonical clone directories must contain regular files');
        const bytes = await privateBytes(path, 10 * 1024 * 1024);
        digest.update(`${name.length}:${name}:${bytes.length}:`).update(bytes);
        const destination = join(target, name);
        await writePrivate(destination, bytes);
        await utimes(destination, metadata.atime, metadata.mtime);
    }
    const handle = await open(target, constants.O_RDONLY);
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function missingDocuments(target, names, now) {
    const documents = {
        'resume-operation.json': fromJSON({ schemaVersion: 1, operation: null }),
        'resume-extractions.json': fromJSON({ schemaVersion: 1, proposals: {}, metadata: { createdAt: now, updatedAt: now } }),
        'resume-extraction-requests.json': fromJSON({ schemaVersion: 1, requests: {}, metadata: { createdAt: now, updatedAt: now } }),
        'resume-extraction-journal.json': fromJSON({ schemaVersion: 1, operation: null }),
        'resume-facts.json': fromJSON({ schemaVersion: 1, sets: {}, metadata: { createdAt: now, updatedAt: now } }),
        'coordinator.json': fromJSON({ schemaVersion: 1, claim: null }),
        'coordinator-journal.json': fromJSON({ schemaVersion: 1, operation: null }),
        'account-operation-journal.json': emptyAccountOperationJournal(),
        'trusted-fill.json': fromJSON({ schemaVersion: 1, approvals: {}, metadata: { createdAt: now, updatedAt: now } }),
    };
    for (const [name, document] of Object.entries(initialAutomationDocuments(now))) {
        documents[`${name}.json`] = document;
    }
    for (const [name, document] of Object.entries(documents))
        if (!names.has(name)) {
            await atomicWritePointJson(join(target, name), document, options);
            names.add(name);
        }
}
async function storeTreeLocked(source, entries, provider, candidate = false, signal = AbortSignal.timeout(30_000), policy) {
    for (const name of directories)
        await privateDirectory(join(source, name), `canonical ${name}`);
    const digest = createHash('sha256');
    for (const name of [...entries].sort()) {
        if (name === '.store.lock' || name === nativePolicyTreeName || (candidate && name === nativeCloneMarkerName))
            continue;
        if (directories.has(name)) {
            digest.update(`directory:${name.length}:${name}:`);
            for (const child of (await readdir(join(source, name))).sort()) {
                if (!/^[A-Za-z0-9._-]{1,200}$/.test(child) || child === '.' || child === '..') {
                    throw new JobsError('canonical clone directory entry is unsupported');
                }
                const bytes = await privateBytes(join(source, name, child), 10 * 1024 * 1024);
                digest.update(`${child.length}:${child}:${bytes.length}:`).update(bytes);
            }
        }
        else {
            const bytes = await privateBytes(join(source, name));
            digest.update(`${name.length}:${name}:${bytes.length}:`).update(bytes);
        }
    }
    if (policy === undefined) {
        await withNativePolicyTree(source, provider, async (snapshot) => { updateNativePolicyDigest(digest, snapshot); }, signal);
    }
    else
        updateNativePolicyDigest(digest, policy);
    return `sha256:${digest.digest('hex')}`;
}
/** Computes the source digest. The caller must hold the source Store lock. */
export async function canonicalStoreSourceTreeLocked(source, provider, signal = AbortSignal.timeout(30_000), policy) {
    const entries = new Set(await readdir(source));
    if (coreFiles.some(name => !entries.has(name)) || [...entries].some(name => !sourceFiles.has(name))) {
        throw new JobsError('canonical clone source contains unsupported or incomplete state');
    }
    return storeTreeLocked(source, entries, provider, false, signal, policy);
}
/** Computes the prepared candidate digest. The caller must hold the candidate Store lock. */
export async function canonicalStoreCandidateTreeLocked(root, provider, signal = AbortSignal.timeout(30_000), policy) {
    const entries = new Set(await readdir(root));
    const allowed = new Set([...nativeStoreRequiredEntries, nativeCloneMarkerName, nativePolicyTreeName, 'resume-facts.json']);
    if (nativeStoreRequiredEntries.some(name => !entries.has(name)) || [...entries].some(name => !allowed.has(name))) {
        throw new JobsError('canonical clone candidate contains unsupported or incomplete state');
    }
    return storeTreeLocked(root, entries, provider, true, signal, policy);
}
/** Computes the clone marker digest while holding the canonical Store lock. */
export async function canonicalStoreSourceTree(source, provider, signal = AbortSignal.timeout(30_000)) {
    await privateDirectory(source, 'canonical clone source');
    return withExclusiveFileLock(join(source, '.store.lock'), async () => canonicalStoreSourceTreeLocked(source, provider, signal), {
        provider, pathProfile: '3.12', signal,
    });
}
/** Copies an existing canonical Store into a new native-owned migration target. */
export async function prepareCanonicalStoreClone(source, target, provider, now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
    if (![source, target].every(path => isAbsolute(path) && path === resolve(path)) || source === target
        || await realpath(dirname(target)).catch(() => null) !== dirname(target))
        throw new JobsError('canonical clone paths are invalid');
    await privateDirectory(source, 'canonical clone source');
    await privateDirectory(dirname(target), 'canonical clone target parent');
    let created = false;
    try {
        await withExclusiveFileLock(join(source, '.store.lock'), async () => {
            const entries = new Set(await readdir(source));
            if (coreFiles.some(name => !entries.has(name)) || [...entries].some(name => !sourceFiles.has(name))) {
                throw new JobsError('canonical clone source contains unsupported or incomplete state');
            }
            for (const name of directories)
                await privateDirectory(join(source, name), `canonical ${name}`);
            await mkdir(target, { mode: 0o700 });
            created = true;
            await chmod(target, 0o700);
            const digest = createHash('sha256'), copied = new Set();
            for (const name of [...entries].sort()) {
                if (name === '.store.lock')
                    continue;
                if (name === nativePolicyTreeName)
                    continue;
                if (directories.has(name)) {
                    digest.update(`directory:${name.length}:${name}:`);
                    await copyDirectory(join(source, name), join(target, name), digest);
                }
                else {
                    const bytes = await privateBytes(join(source, name));
                    digest.update(`${name.length}:${name}:${bytes.length}:`).update(bytes);
                    await writePrivate(join(target, name), bytes);
                }
                copied.add(name);
            }
            await withNativePolicyTree(source, provider, async (policy) => {
                updateNativePolicyDigest(digest, policy);
                await copyNativePolicyTree(target, policy);
                if (policy)
                    copied.add(nativePolicyTreeName);
            });
            await writePrivate(join(target, '.store.lock'), Buffer.alloc(0));
            copied.add('.store.lock');
            await missingDocuments(target, copied, now);
            if (nativeStoreRequiredEntries.some(name => !copied.has(name)))
                throw new JobsError('canonical clone target is incomplete');
            const sourceTree = `sha256:${digest.digest('hex')}`;
            await withExclusiveFileLock(join(target, '.store.lock'), async () => {
                const candidateTree = await canonicalStoreCandidateTreeLocked(target, provider);
                const marker = Buffer.from(JSON.stringify({ mode: 'canonical-store-clone', version: 2,
                    sourceTree, candidateTree }) + '\n');
                await writePrivate(join(target, nativeCloneMarkerName), marker);
            }, { provider, pathProfile: '3.12', signal: AbortSignal.timeout(30_000) });
            const directory = await open(target, constants.O_RDONLY);
            try {
                await directory.sync();
            }
            finally {
                await directory.close();
            }
        }, { provider, pathProfile: '3.12', signal: AbortSignal.timeout(30_000) });
    }
    catch (error) {
        if (created)
            await rm(target, { recursive: true, force: true });
        throw error;
    }
}
