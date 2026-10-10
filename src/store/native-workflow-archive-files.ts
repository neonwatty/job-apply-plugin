import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { archiveCheck, archiveSegmentCodeUnitLimit, archiveSegmentLimit, WorkflowArchiveError } from '../contracts/workspace/workflow-archive.js';

export const workflowArchiveDirectory = 'workflow-archive';
const pendingName = '.pending';
const filePattern = /^[a-f0-9]{64}\.json$/;
const byteLimit = archiveSegmentCodeUnitLimit * 4;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const owned = (info: Stats) => info.uid === process.getuid?.();
const same = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;
export const archiveDigest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Every operation runs under the canonical Store lock. No directory scans exceed 34 entries. */
export class NativeWorkflowArchiveFiles {
  private readonly directory: string;
  constructor(private readonly root: string, private readonly checkpoint: (stage: string) => Promise<void> = async () => {}) {
    this.directory = join(root, workflowArchiveDirectory);
  }
  private async directoryInfo(optional: boolean): Promise<Stats | null> {
    let info;
    try { info = await lstat(this.directory); }
    catch (error) { if (optional && missing(error)) return null; throw new WorkflowArchiveError(); }
    archiveCheck(info.isDirectory() && !info.isSymbolicLink() && owned(info) && (info.mode & 0o777) === 0o700);
    return info;
  }
  private async file(name: string, read: boolean): Promise<Buffer> {
    archiveCheck(name === pendingName || filePattern.test(name));
    let handle;
    try {
      handle = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat(), current = await lstat(join(this.directory, name));
      archiveCheck(info.isFile() && info.nlink === 1 && owned(info) && (info.mode & 0o777) === 0o600
        && info.size <= byteLimit && !current.isSymbolicLink() && same(info, current));
      return read ? await handle.readFile() : Buffer.alloc(0);
    } catch { throw new WorkflowArchiveError(); }
    finally { await handle?.close(); }
  }
  async inventory(required: boolean): Promise<string[]> {
    const before = await this.directoryInfo(!required);
    if (!before) return [];
    const names: string[] = [];
    const directory = await opendir(this.directory);
    try {
      for await (const entry of directory) {
        archiveCheck(names.length < archiveSegmentLimit + 2 && (entry.name === pendingName || filePattern.test(entry.name)));
        await this.file(entry.name, false); names.push(entry.name);
      }
    } catch { throw new WorkflowArchiveError(); }
    const after = await this.directoryInfo(false);
    archiveCheck(after && same(before, after));
    return names;
  }
  async read(digest: string): Promise<Buffer> {
    archiveCheck(/^[a-f0-9]{64}$/.test(digest));
    await this.directoryInfo(false);
    const bytes = await this.file(`${digest}.json`, true);
    archiveCheck(archiveDigest(bytes) === digest);
    return bytes;
  }
  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  /** Write and sync immutable data before any root/journal publication. Unreferenced files are garbage. */
  async publish(bytes: string, retained: string[]): Promise<string> {
    archiveCheck(bytes.length <= archiveSegmentCodeUnitLimit && retained.length < archiveSegmentLimit);
    const digest = archiveDigest(bytes);
    archiveCheck(!retained.includes(digest));
    const existed = await this.directoryInfo(true);
    if (!existed) {
      await mkdir(this.directory, { mode: 0o700 });
      await this.syncDirectory(this.root);
    }
    const names = await this.inventory(true), keep = new Set(retained.map(value => `${value}.json`));
    // Validate all destinations first, including disposable interrupted writes.
    for (const name of names) if (!keep.has(name)) await unlink(join(this.directory, name));
    await this.syncDirectory(this.directory);
    const handle = await open(join(this.directory, pendingName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
      await this.checkpoint('archive_file_written');
      await handle.sync();
      await this.checkpoint('archive_file_synced');
    } finally { await handle.close(); }
    await rename(join(this.directory, pendingName), join(this.directory, `${digest}.json`));
    await this.syncDirectory(this.directory);
    await this.checkpoint('archive_segment_published');
    return digest;
  }
}
