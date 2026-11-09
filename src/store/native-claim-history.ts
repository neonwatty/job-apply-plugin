import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePythonPointJsonBytes } from '../contracts/raw-json/point-parser.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { validateAnswerHistory } from '../contracts/workspace/answer-session-validation.js';
import { get, string, JobsError } from '../contracts/workspace/values.js';
import type { Document } from '../contracts/workspace/values.js';
import { strip } from '../contracts/workspace/job-url.js';
import { encodePointJsonlJson } from './point-persistence.js';

/** Caller holds the Store lock. Descriptor checks also apply during recovery. */
export class NativeClaimHistory {
  constructor(private readonly root: string) {}
  private async handle(writable: boolean) {
    const handle = await open(join(this.root, 'applications.jsonl'),
      (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
        throw new JobsError('native history must be private and owned, without links');
      }
      if (stat.size > 32 * 1024 * 1024) throw new JobsError('native history exceeds supported size');
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async read(): Promise<Document[]> {
    const handle = await this.handle(false);
    try {
      const content = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(await handle.readFile());
      return content.split('\n').filter(line => strip(line)).map(line => validateAnswerHistory(
        parsePythonPointJsonBytes(Buffer.from(line), {diagnosticProfile:'3.12',intMaxStrDigits:4300})));
    } finally { await handle.close(); }
  }
  async repairPendingTail(): Promise<void> {
    const handle = await this.handle(true);
    try {
      const content = await handle.readFile();
      if (!content.length || content.at(-1) === 10) return;
      await handle.truncate(content.lastIndexOf(10) + 1);
      await handle.sync();
    } finally { await handle.close(); }
  }
  async isIdempotent(event: Document): Promise<boolean> {
    validateAnswerHistory(event);
    const matching = (await this.read()).filter(item => string(get(item,'eventId')) === string(get(event,'eventId')));
    if (!matching.length) return false;
    const expected = canonicalJson(event);
    if (matching.every(item => canonicalJson(item) === expected)) return true;
    throw new JobsError('history event id collision');
  }
  async append(event: Document): Promise<void> {
    if (await this.isIdempotent(event)) return;
    const encoded = encodePointJsonlJson(event, {pathProfile:'3.12',intMaxStrDigits:4300});
    const handle = await this.handle(true);
    try {
      const original = (await handle.stat()).size;
      try {
        let offset = 0;
        while (offset < encoded.length) {
          const {bytesWritten} = await handle.write(encoded, offset, encoded.length-offset, original+offset);
          if (bytesWritten <= 0) throw new JobsError('history append was incomplete');
          offset += bytesWritten;
        }
        await handle.sync();
      } catch (error) { await handle.truncate(original); await handle.sync(); throw error; }
    } finally { await handle.close(); }
  }
}
