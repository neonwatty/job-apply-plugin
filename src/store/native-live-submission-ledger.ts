import { constants } from 'node:fs';
import { join } from 'node:path';
import { fromJSON, JobsError } from '../contracts/workspace/values.js';
import { liveSubmissionJobKey, type SubmissionLedger } from '../workspace-core/live-submission.js';
import { atomicWritePointJson } from './point-persistence.js';
import { openPrivateStoreFile } from './private-store-entry.js';
import { nativeLiveSubmissionName } from './native-store-layout.js';

/** The caller holds the canonical Store lock for every access. */
export class NativeLiveSubmissionLedger implements SubmissionLedger {
  private readonly path: string;
  constructor(root: string) { this.path = join(root, nativeLiveSubmissionName); }

  private key(key: string) {
    if (key !== 'review-fingerprint-key' && !/^(approval|job)-[a-f0-9]{64}$/.test(key)) throw new JobsError('invalid submission ledger key');
    return key;
  }

  private async load(): Promise<Record<string, unknown>> {
    try {
      const handle = await openPrivateStoreFile(this.path, constants.O_RDONLY, 'submission ledger is unavailable');
      try {
        if ((await handle.stat()).size > 32 * 1024 * 1024) throw new JobsError('submission ledger is invalid');
        const value: unknown = JSON.parse(await handle.readFile('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JobsError('submission ledger is invalid');
        return value as Record<string, unknown>;
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async read(key: string): Promise<unknown> {
    return this.record(await this.load(), this.key(key));
  }

  async readJobs(ids: string[]): Promise<Map<string, unknown>> {
    if (!ids.length) return new Map();
    const values = await this.load();
    return new Map(ids.map(id => [id, this.record(values, liveSubmissionJobKey(id))]));
  }

  private record(values: Record<string, unknown>, id: string): unknown {
    if (!Object.hasOwn(values, id)) return null;
    const record = values[id];
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new JobsError('submission ledger is invalid');
    return record;
  }

  async write(key: string, value: unknown): Promise<void> {
    const id = this.key(key), current = await this.load();
    const options = { pathProfile: '3.12' as const, intMaxStrDigits: 4300 };
    if (value === null) delete current[id];
    else current[id] = value;
    await atomicWritePointJson(this.path, fromJSON(current), options);
  }
}
