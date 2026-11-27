import { constants } from 'node:fs';
import { join } from 'node:path';
import { fromJSON, JobsError } from '../contracts/workspace/values.js';
import { liveSubmissionJobKey } from '../workspace-core/live-submission.js';
import { atomicWritePointJson } from './point-persistence.js';
import { openPrivateStoreFile } from './private-store-entry.js';
import { nativeLiveSubmissionName } from './native-store-layout.js';
/** The caller holds the canonical Store lock for every access. */
export class NativeLiveSubmissionLedger {
    path;
    constructor(root) { this.path = join(root, nativeLiveSubmissionName); }
    key(key) {
        if (key !== 'review-fingerprint-key' && !/^(approval|job)-[a-f0-9]{64}$/.test(key))
            throw new JobsError('invalid submission ledger key');
        return key;
    }
    async load() {
        try {
            const handle = await openPrivateStoreFile(this.path, constants.O_RDONLY, 'submission ledger is unavailable');
            try {
                if ((await handle.stat()).size > 32 * 1024 * 1024)
                    throw new JobsError('submission ledger is invalid');
                const value = JSON.parse(await handle.readFile('utf8'));
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    throw new JobsError('submission ledger is invalid');
                return value;
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return {};
            throw error;
        }
    }
    async read(key) {
        return this.record(await this.load(), this.key(key));
    }
    async readJobs(ids) {
        if (!ids.length)
            return new Map();
        const values = await this.load();
        return new Map(ids.map(id => [id, this.record(values, liveSubmissionJobKey(id))]));
    }
    record(values, id) {
        if (!Object.hasOwn(values, id))
            return null;
        const record = values[id];
        if (!record || typeof record !== 'object' || Array.isArray(record))
            throw new JobsError('submission ledger is invalid');
        return record;
    }
    async write(key, value) {
        const id = this.key(key), current = await this.load();
        const options = { pathProfile: '3.12', intMaxStrDigits: 4300 };
        if (value === null)
            delete current[id];
        else
            current[id] = value;
        await atomicWritePointJson(this.path, fromJSON(current), options);
    }
}
