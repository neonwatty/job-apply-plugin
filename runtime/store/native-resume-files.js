import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resumeLimit, validateResumeContent } from '../contracts/workspace/resume-content.js';
import { safeId } from '../contracts/workspace/jobs.js';
import { copy, get, has, int, integer, keys, object, same, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { validateExtractionResumes } from './native-extraction-journal.js';
import { resumeModifiedAt } from './resume-modified-at.js';
const filePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(pdf|docx|txt)$/;
const tempPattern = /^\.native-[a-f0-9-]{36}\.tmp$/;
const quarantinePattern = /^\.([A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:pdf|docx|txt))\.([a-f0-9]{32})\.quarantine$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const absent = (error) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
export async function syncDirectory(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
export class NativeResumeFiles {
    checkpoint;
    directory;
    constructor(root, checkpoint = async () => { }) {
        this.checkpoint = checkpoint;
        this.directory = join(root, 'resume-files');
    }
    async validate() {
        const metadata = await lstat(this.directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || metadata.mode & 0o077)
            throw new JobsError('resume directory must be private and owned');
        for (const name of await readdir(this.directory)) {
            if (!filePattern.test(name) && !tempPattern.test(name) && !quarantinePattern.test(name)) {
                throw new JobsError('unsupported resume recovery state');
            }
            const stat = await lstat(join(this.directory, name));
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077)
                throw new JobsError('resume file must be private and owned, without links');
        }
    }
    async readPath(path, privateFile = false) {
        let handle;
        try {
            handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const before = await handle.stat({ bigint: true });
            if (!before.isFile() || before.size > BigInt(resumeLimit) || privateFile && (before.nlink !== 1n || before.uid !== BigInt(process.getuid()) || (before.mode & 63n) !== 0n))
                throw Error('file');
            const parts = [];
            let size = 0;
            while (true) {
                const buffer = Buffer.alloc(Math.min(1024 * 1024, resumeLimit + 1 - size));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (!bytesRead)
                    break;
                parts.push(buffer.subarray(0, bytesRead));
                size += bytesRead;
                if (size > resumeLimit)
                    throw new JobsError('resume file exceeds the 10 MiB limit');
            }
            const after = await handle.stat({ bigint: true }), pathStat = await lstat(path, { bigint: true });
            if (size !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])
                || pathStat.dev !== after.dev || pathStat.ino !== after.ino || pathStat.isSymbolicLink())
                throw new JobsError('resume source changed during import');
            return Buffer.concat(parts);
        }
        catch (error) {
            if (error instanceof JobsError)
                throw error;
            throw new JobsError(privateFile ? 'managed resume content is unavailable' : 'resume source must be a readable regular file');
        }
        finally {
            await handle?.close();
        }
    }
    async stage(id, filename, content) {
        const { extension, mediaType } = validateResumeContent(filename, content);
        const temporary = `.native-${randomUUID()}.tmp`, path = join(this.directory, temporary);
        const handle = await open(path, 'wx', 0o600);
        try {
            await handle.writeFile(content);
            await handle.sync();
            const stat = await handle.stat();
            await syncDirectory(this.directory);
            return { temporary, managedFile: id + extension, originalFilename: filename, mediaType,
                digest: hash(content), observedSize: content.length, observedModifiedAt: resumeModifiedAt(stat.mtimeMs / 1000) };
        }
        catch (error) {
            await unlink(path).catch(() => { });
            throw error;
        }
        finally {
            await handle.close();
        }
    }
    async discard(stage) {
        try {
            await unlink(join(this.directory, stage.temporary));
        }
        catch (error) {
            if (!absent(error))
                throw error;
        }
    }
    async content(record) {
        if (string(get(record, 'storageKind')) !== 'managed')
            throw new JobsError('resume must be adopted before use');
        const bytes = await this.readPath(join(this.directory, string(get(record, 'managedFile'))), true);
        if (hash(bytes) !== string(get(record, 'digest')))
            throw new JobsError('managed resume content is unavailable');
        return bytes;
    }
    path(record) {
        if (string(get(record, 'storageKind')) !== 'managed')
            throw new JobsError('resume must be adopted before use');
        const file = string(get(record, 'managedFile'));
        if (!file || !filePattern.test(file))
            throw new JobsError('managed resume content is unavailable');
        return join(this.directory, file);
    }
    async observation(record) {
        const path = this.path(record);
        let stat;
        try {
            stat = await lstat(path);
        }
        catch (error) {
            if (absent(error))
                return { exists: false, size: null, modifiedAt: null, digest: null };
            throw error;
        }
        const bytes = await this.readPath(path, true);
        stat = await lstat(path);
        return { exists: true, size: bytes.length, modifiedAt: resumeModifiedAt(stat.mtimeMs / 1000), digest: hash(bytes) };
    }
    async externalObservation(path) {
        try {
            const stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new JobsError('resume source must be a readable regular file');
            return { exists: true, size: stat.size, modifiedAt: resumeModifiedAt(stat.mtimeMs / 1000), digest: null };
        }
        catch (error) {
            if (absent(error))
                return { exists: false, size: null, modifiedAt: null, digest: null };
            throw error;
        }
    }
    /** Journal is durable before any canonical rename. Recovery completes only its exact intended record. */
    async install(stage, document, previous, saveJournal, save) {
        const journal = emptyObject();
        set(journal, 'version', integer(1n));
        set(journal, 'kind', text('install'));
        set(journal, 'temporary', text(stage.temporary));
        set(journal, 'destination', text(stage.managedFile));
        set(journal, 'previous', previous === null ? null : text(previous));
        set(journal, 'digest', text(stage.digest));
        set(journal, 'document', document);
        await saveJournal(journal);
        await this.checkpoint('journal');
        await rename(join(this.directory, stage.temporary), join(this.directory, stage.managedFile));
        await syncDirectory(this.directory);
        await this.checkpoint('installed');
        await save(document);
        await this.checkpoint('metadata');
        if (previous && previous !== stage.managedFile) {
            try {
                await unlink(join(this.directory, previous));
            }
            catch (error) {
                if (!absent(error))
                    throw error;
            }
        }
        await syncDirectory(this.directory);
        await saveJournal(null);
        await this.checkpoint('cleared');
    }
    /** A durable intent makes every delete crash window recoverable without guessing. */
    async delete(record, previousDocument, document, saveJournal, save, readCurrent) {
        if (string(get(record, 'storageKind')) !== 'managed') {
            await save(document);
            return;
        }
        const source = string(get(record, 'managedFile')), sourcePath = this.path(record);
        try {
            await lstat(sourcePath);
        }
        catch (error) {
            if (absent(error)) {
                await save(document);
                return;
            }
            throw error;
        }
        const quarantine = `.${source}.${randomUUID().replaceAll('-', '')}.quarantine`;
        const journal = emptyObject();
        set(journal, 'version', integer(1n));
        set(journal, 'kind', text('delete'));
        set(journal, 'id', get(record, 'id'));
        set(journal, 'source', text(source));
        set(journal, 'quarantine', text(quarantine));
        set(journal, 'digest', get(record, 'digest'));
        set(journal, 'previousDocument', previousDocument);
        set(journal, 'document', document);
        await saveJournal(journal);
        await this.checkpoint('delete-journal');
        await rename(sourcePath, join(this.directory, quarantine));
        await syncDirectory(this.directory);
        await this.checkpoint('delete-quarantined');
        try {
            await save(document);
        }
        catch (error) {
            // Atomic replacement may report a later chmod/fsync failure after installing
            // the intended document. Roll back bytes only when disk still proves the old
            // document; otherwise preserve the journal and quarantine for recovery.
            let current = null;
            try {
                current = await readCurrent();
            }
            catch { /* Preserve recoverable intent. */ }
            if (current && same(current, previousDocument)) {
                await saveJournal(null);
                await rename(join(this.directory, quarantine), sourcePath);
                await syncDirectory(this.directory);
            }
            throw error;
        }
        await this.checkpoint('delete-metadata');
        try {
            await unlink(join(this.directory, quarantine));
        }
        catch (error) {
            if (!absent(error)) { /* Python tolerates cleanup failure. */ }
        }
        await syncDirectory(this.directory);
        await saveJournal(null);
        await this.checkpoint('delete-cleared');
    }
    async recover(journal, current, save, clear) {
        await this.validate();
        if (journal) {
            if (string(get(journal, 'kind')) === 'delete') {
                await this.recoverDelete(journal, current, save, clear);
                current = validateExtractionResumes(object(get(journal, 'document'), 'resume delete document'));
            }
            else {
                if (int(get(journal, 'version')) !== 1n || string(get(journal, 'kind')) !== 'install' || journal.size !== 7
                    || keys(journal).some(key => !['version', 'kind', 'temporary', 'destination', 'previous', 'digest', 'document'].includes(key)))
                    throw new JobsError('invalid resume recovery journal');
                const temporary = string(get(journal, 'temporary')), destination = string(get(journal, 'destination'));
                const previous = string(get(journal, 'previous')), digest = string(get(journal, 'digest'));
                if (!temporary || !tempPattern.test(temporary) || !destination || !filePattern.test(destination) || !digest || !/^[a-f0-9]{64}$/.test(digest)
                    || get(journal, 'previous') !== null && (!previous || !filePattern.test(previous)))
                    throw new JobsError('invalid resume recovery journal');
                const document = object(get(journal, 'document'), 'resume recovery document');
                const records = object(get(document, 'resumes'), 'resumes.resumes');
                const matches = records.entries().filter(([, value]) => string(get(object(value, 'resume'), 'managedFile')) === destination
                    && string(get(object(value, 'resume'), 'digest')) === digest);
                if (matches.length !== 1)
                    throw new JobsError('resume recovery identity differs');
                const oldRecords = object(get(current, 'resumes'), 'resumes.resumes');
                const targetId = string(matches[0][0]);
                if (previous && (!has(oldRecords, targetId) || ![previous, destination].includes(string(get(object(get(oldRecords, targetId), 'resume'), 'managedFile')))))
                    throw new JobsError('resume recovery previous identity differs');
                let installed = false;
                try {
                    installed = hash(await this.readPath(join(this.directory, destination), true)) === digest;
                }
                catch { /* Staged bytes must prove the expected digest below. */ }
                if (!installed) {
                    const bytes = await this.readPath(join(this.directory, temporary), true);
                    if (hash(bytes) !== digest)
                        throw new JobsError('resume recovery bytes are unavailable');
                    await rename(join(this.directory, temporary), join(this.directory, destination));
                    await syncDirectory(this.directory);
                }
                await save(document);
                if (previous && previous !== destination) {
                    try {
                        await unlink(join(this.directory, previous));
                    }
                    catch (error) {
                        if (!absent(error))
                            throw error;
                    }
                }
                await syncDirectory(this.directory);
                await clear();
            }
        }
        // Only owned native staging names are collected under the Store lock.
        for (const name of await readdir(this.directory))
            if (tempPattern.test(name))
                await unlink(join(this.directory, name));
        await this.reconcileQuarantines(current);
        await syncDirectory(this.directory);
    }
    async recoverDelete(journal, current, save, clear) {
        const fields = ['version', 'kind', 'id', 'source', 'quarantine', 'digest', 'previousDocument', 'document'];
        if (int(get(journal, 'version')) !== 1n || journal.size !== fields.length || keys(journal).some(key => !fields.includes(key))) {
            throw new JobsError('invalid resume recovery journal');
        }
        const id = safeId(string(get(journal, 'id'))), source = string(get(journal, 'source'));
        const quarantine = string(get(journal, 'quarantine')), digest = string(get(journal, 'digest'));
        if (!source || !filePattern.test(source) || !quarantine || quarantinePattern.exec(quarantine)?.[1] !== source
            || !digest || !/^[a-f0-9]{64}$/.test(digest))
            throw new JobsError('invalid resume recovery journal');
        const previous = validateExtractionResumes(object(get(journal, 'previousDocument'), 'resume delete previous document'));
        const intended = validateExtractionResumes(object(get(journal, 'document'), 'resume delete document'));
        const previousRecords = object(get(previous, 'resumes'), 'resumes.resumes');
        const record = object(get(previousRecords, id), 'deleted resume');
        if (get(record, 'deletedAt') === null || string(get(record, 'managedFile')) !== source
            || string(get(record, 'digest')) !== digest || has(object(get(intended, 'resumes'), 'resumes.resumes'), id)) {
            throw new JobsError('resume recovery identity differs');
        }
        const derived = copy(previous), derivedRecords = copy(object(get(derived, 'resumes'), 'resumes.resumes'));
        const derivedMetadata = copy(object(get(derived, 'metadata'), 'resumes.metadata'));
        set(derived, 'resumes', derivedRecords);
        set(derived, 'metadata', derivedMetadata);
        derivedRecords.delete(text(id));
        set(derivedMetadata, 'updatedAt', get(object(get(intended, 'metadata'), 'resumes.metadata'), 'updatedAt'));
        if (!same(derived, intended))
            throw new JobsError('resume recovery identity differs');
        const before = same(current, previous), after = same(current, intended);
        if (!before && !after)
            throw new JobsError('resume recovery document differs');
        const sourcePath = join(this.directory, source), quarantinePath = join(this.directory, quarantine);
        const sourceExists = await lstat(sourcePath).then(() => true, error => absent(error) ? false : Promise.reject(error));
        const quarantineExists = await lstat(quarantinePath).then(() => true, error => absent(error) ? false : Promise.reject(error));
        if (before) {
            if (sourceExists === quarantineExists)
                throw new JobsError('resume recovery bytes are unavailable');
            if (sourceExists) {
                await rename(sourcePath, quarantinePath);
                await syncDirectory(this.directory);
            }
            if (hash(await this.readPath(quarantinePath, true)) !== digest)
                throw new JobsError('resume recovery bytes are unavailable');
            await save(intended);
        }
        else if (sourceExists)
            throw new JobsError('resume recovery identity differs');
        if (await lstat(quarantinePath).then(() => true, error => absent(error) ? false : Promise.reject(error))) {
            await unlink(quarantinePath);
        }
        await syncDirectory(this.directory);
        await clear();
    }
    async reconcileQuarantines(current) {
        const records = object(get(validateExtractionResumes(current), 'resumes'), 'resumes.resumes');
        const groups = new Map();
        for (const name of await readdir(this.directory)) {
            const match = quarantinePattern.exec(name);
            if (match)
                groups.set(match[1], [...(groups.get(match[1]) ?? []), name]);
        }
        for (const [source, quarantines] of groups) {
            const record = records.entries().map(([, value]) => object(value, 'resume')).find(value => string(get(value, 'managedFile')) === source);
            const sourcePath = join(this.directory, source);
            const sourceExists = await lstat(sourcePath).then(() => true, error => absent(error) ? false : Promise.reject(error));
            const sourceMatches = record && sourceExists
                ? hash(await this.readPath(sourcePath, true)) === string(get(record, 'digest')) : false;
            if (record && !sourceMatches) {
                const digest = string(get(record, 'digest'));
                const matches = [];
                for (const name of quarantines)
                    if (hash(await this.readPath(join(this.directory, name), true)) === digest)
                        matches.push(name);
                if (matches.length !== 1)
                    throw new JobsError('resume recovery bytes are unavailable');
                if (sourceExists)
                    await unlink(sourcePath);
                await rename(join(this.directory, matches[0]), sourcePath);
            }
            for (const name of quarantines) {
                try {
                    await unlink(join(this.directory, name));
                }
                catch (error) {
                    if (!absent(error))
                        throw error;
                }
            }
        }
    }
}
