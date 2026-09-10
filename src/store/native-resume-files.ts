import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resumeLimit, validateResumeContent } from '../contracts/workspace/resume-content.js';
import { get, has, int, integer, keys, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { resumeModifiedAt } from './resume-modified-at.js';
export type StagedResume = { temporary: string; managedFile: string; originalFilename: string; mediaType: string; digest: string; observedSize: number; observedModifiedAt: string };
const filePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(pdf|docx|txt)$/;
const tempPattern = /^\.native-[a-f0-9-]{36}\.tmp$/;
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const absent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export class NativeResumeFiles {
  readonly directory: string;
  constructor(root: string, private readonly checkpoint: (stage: string) => Promise<void> = async () => {}) {
    this.directory = join(root, 'resume-files');
  }
  async validate(): Promise<void> {
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || metadata.mode & 0o077) throw new JobsError('resume directory must be private and owned');
    for (const name of await readdir(this.directory)) {
      if (!filePattern.test(name) && !tempPattern.test(name)) throw new JobsError('unsupported resume recovery state');
      const stat = await lstat(join(this.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new JobsError('resume file must be private and owned, without links');
    }
  }
  async readPath(path: string, privateFile = false): Promise<Buffer> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(resumeLimit) || privateFile && (before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o077n) !== 0n)) throw Error('file');
      const parts: Buffer[] = [];
      let size = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(1024 * 1024, resumeLimit + 1 - size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        parts.push(buffer.subarray(0, bytesRead)); size += bytesRead;
        if (size > resumeLimit) throw new JobsError('resume file exceeds the 10 MiB limit');
      }
      const after = await handle.stat({ bigint: true }), pathStat = await lstat(path, { bigint: true });
      if (size !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])
        || pathStat.dev !== after.dev || pathStat.ino !== after.ino || pathStat.isSymbolicLink()) throw new JobsError('resume source changed during import');
      return Buffer.concat(parts);
    } catch (error) {
      if (error instanceof JobsError) throw error;
      throw new JobsError(privateFile ? 'managed resume content is unavailable' : 'resume source must be a readable regular file');
    } finally { await handle?.close(); }
  }
  async stage(id: string, filename: string, content: Buffer): Promise<StagedResume> {
    const { extension, mediaType } = validateResumeContent(filename, content);
    const temporary = `.native-${randomUUID()}.tmp`, path = join(this.directory, temporary);
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(content); await handle.sync();
      const stat = await handle.stat();
      await syncDirectory(this.directory);
      return { temporary, managedFile: id + extension, originalFilename: filename, mediaType,
        digest: hash(content), observedSize: content.length, observedModifiedAt: resumeModifiedAt(stat.mtimeMs / 1000) };
    } catch (error) { await unlink(path).catch(() => {}); throw error; }
    finally { await handle.close(); }
  }
  async discard(stage: StagedResume): Promise<void> {
    try { await unlink(join(this.directory, stage.temporary)); }
    catch (error) { if (!absent(error)) throw error; }
  }
  async content(record: Document): Promise<Buffer> {
    if (string(get(record, 'storageKind')) !== 'managed') throw new JobsError('resume must be adopted before use');
    const bytes = await this.readPath(join(this.directory, string(get(record, 'managedFile'))!), true);
    if (hash(bytes) !== string(get(record, 'digest'))) throw new JobsError('managed resume content is unavailable');
    return bytes;
  }
  path(record: Document): string {
    if (string(get(record, 'storageKind')) !== 'managed') throw new JobsError('resume must be adopted before use');
    const file = string(get(record, 'managedFile'));
    if (!file || !filePattern.test(file)) throw new JobsError('managed resume content is unavailable');
    return join(this.directory, file);
  }
  async observation(record: Document): Promise<{ exists: boolean; size: number | null; modifiedAt: string | null; digest: string | null }> {
    const path = this.path(record);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (absent(error)) return { exists: false, size: null, modifiedAt: null, digest: null };
      throw error;
    }
    const bytes = await this.readPath(path, true);
    stat = await lstat(path);
    return { exists: true, size: bytes.length, modifiedAt: resumeModifiedAt(stat.mtimeMs / 1000), digest: hash(bytes) };
  }
  async externalObservation(path: string): Promise<{ exists: boolean; size: number | null; modifiedAt: string | null; digest: null }> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new JobsError('resume source must be a readable regular file');
      return { exists: true, size: stat.size, modifiedAt: resumeModifiedAt(stat.mtimeMs / 1000), digest: null };
    } catch (error) {
      if (absent(error)) return { exists: false, size: null, modifiedAt: null, digest: null };
      throw error;
    }
  }
  /** Journal is durable before any canonical rename. Recovery completes only its exact intended record. */
  async install(stage: StagedResume, document: Document, previous: string | null, saveJournal: (value: Value) => Promise<void>, save: (value: Document) => Promise<void>): Promise<void> {
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
      try { await unlink(join(this.directory, previous)); } catch (error) { if (!absent(error)) throw error; }
    }
    await syncDirectory(this.directory);
    await saveJournal(null);
    await this.checkpoint('cleared');
  }
  async recover(journal: Document | null, current: Document, save: (value: Document) => Promise<void>, clear: () => Promise<void>): Promise<void> {
    await this.validate();
    if (journal) {
      if (int(get(journal, 'version')) !== 1n || string(get(journal, 'kind')) !== 'install' || journal.size !== 7
        || keys(journal).some(key => !['version','kind','temporary','destination','previous','digest','document'].includes(key))) throw new JobsError('invalid resume recovery journal');
      const temporary = string(get(journal, 'temporary')), destination = string(get(journal, 'destination')), previous = string(get(journal, 'previous')), digest = string(get(journal, 'digest'));
      if (!temporary || !tempPattern.test(temporary) || !destination || !filePattern.test(destination) || !digest || !/^[a-f0-9]{64}$/.test(digest)
        || get(journal, 'previous') !== null && (!previous || !filePattern.test(previous))) throw new JobsError('invalid resume recovery journal');
      const document = object(get(journal, 'document'), 'resume recovery document');
      const records = object(get(document, 'resumes'), 'resumes.resumes');
      const matches = records.entries().filter(([, value]) => string(get(object(value, 'resume'), 'managedFile')) === destination && string(get(object(value, 'resume'), 'digest')) === digest);
      if (matches.length !== 1) throw new JobsError('resume recovery identity differs');
      const oldRecords = object(get(current, 'resumes'), 'resumes.resumes');
      const targetId = string(matches[0]![0])!;
      if (previous && (!has(oldRecords, targetId) || ![previous, destination].includes(string(get(object(get(oldRecords,targetId),'resume'),'managedFile'))!))) throw new JobsError('resume recovery previous identity differs');
      let installed = false;
      try { installed = hash(await this.readPath(join(this.directory, destination), true)) === digest; } catch { /* Staged bytes must prove the expected digest below. */ }
      if (!installed) {
        const bytes = await this.readPath(join(this.directory, temporary), true);
        if (hash(bytes) !== digest) throw new JobsError('resume recovery bytes are unavailable');
        await rename(join(this.directory, temporary), join(this.directory, destination));
        await syncDirectory(this.directory);
      }
      await save(document);
      if (previous && previous !== destination) {
        try { await unlink(join(this.directory, previous)); } catch (error) { if (!absent(error)) throw error; }
      }
      await syncDirectory(this.directory); await clear();
    }
    // Only owned native staging names are collected under the Store lock.
    for (const name of await readdir(this.directory)) if (tempPattern.test(name)) await unlink(join(this.directory, name));
    await syncDirectory(this.directory);
  }
}
