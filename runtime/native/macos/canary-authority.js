import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parsePythonPointJsonBytes } from '../../contracts/raw-json/point-parser.js';
import { canaryBindingDigest, canaryFinalScopeDigest, privateCanaryDigest, validateOracleCanaryBinding } from '../../contracts/workspace/account-canary.js';
import { fromJSON, serialize, JobsError } from '../../contracts/workspace/values.js';
import { withExclusiveFileLock } from '../../store/exclusive-file-lock.js';
import { atomicWritePointJson } from '../../store/point-persistence.js';
const options = { pathProfile: '3.12', intMaxStrDigits: 4300 };
const approvalPattern = /^approval_[0-9a-f]{64}$/u;
const capabilityPattern = /^canary_[0-9a-f]{64}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const empty = () => ({ schemaVersion: 2, preparationApprovals: {}, finalApprovals: {}, attempts: {} });
function validateLedger(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new JobsError('private approval ledger is invalid');
    const row = value;
    if (Object.keys(row).sort().join('\0') !== ['attempts', 'finalApprovals', 'preparationApprovals', 'schemaVersion'].join('\0')
        || row.schemaVersion !== 2 || !row.finalApprovals || typeof row.finalApprovals !== 'object'
        || Array.isArray(row.finalApprovals) || !row.attempts || typeof row.attempts !== 'object'
        || Array.isArray(row.attempts) || !row.preparationApprovals || typeof row.preparationApprovals !== 'object'
        || Array.isArray(row.preparationApprovals)) {
        throw new JobsError('private approval ledger is invalid');
    }
    for (const item of [...Object.values(row.preparationApprovals),
        ...Object.values(row.finalApprovals)]) {
        const approval = item;
        if (!approval || Object.keys(approval).sort().join('\0') !== 'consumed\0scopeDigest'
            || typeof approval.consumed !== 'boolean' || !digestPattern.test(String(approval.scopeDigest))) {
            throw new JobsError('private approval ledger is invalid');
        }
    }
    if ([...Object.keys(row.preparationApprovals), ...Object.keys(row.finalApprovals),
        ...Object.keys(row.attempts)]
        .some(key => !digestPattern.test(key)))
        throw new JobsError('private approval ledger is invalid');
    for (const item of Object.values(row.attempts)) {
        const attempt = item;
        if (!attempt || Object.keys(attempt).sort().join('\0') !== 'attempted\0bindingDigest\0expiresAt'
            || typeof attempt.attempted !== 'boolean' || !digestPattern.test(String(attempt.bindingDigest))
            || typeof attempt.expiresAt !== 'string' || !Number.isFinite(Date.parse(attempt.expiresAt))) {
            throw new JobsError('private approval ledger is invalid');
        }
    }
    return row;
}
export class DurableT007ApprovalLedger {
    path;
    provider;
    constructor(path, provider) {
        this.path = path;
        this.provider = provider;
        if (!isAbsolute(path) || resolve(path) !== path)
            throw new JobsError('private approval ledger path is invalid');
    }
    async read() {
        let handle;
        try {
            handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return empty();
            throw error;
        }
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
                || stat.size > 4 * 1024 * 1024)
                throw new JobsError('private approval ledger is invalid');
            const parsed = parsePythonPointJsonBytes(await handle.readFile(), { diagnosticProfile: '3.12', intMaxStrDigits: 4300 });
            return validateLedger(JSON.parse(serialize(parsed)));
        }
        finally {
            await handle.close();
        }
    }
    write(value) {
        return atomicWritePointJson(this.path, fromJSON(value), options);
    }
    locked(operation) {
        return withExclusiveFileLock(`${this.path}.lock`, async () => operation(await this.read()), {
            provider: this.provider, pathProfile: '3.12', signal: AbortSignal.timeout(30_000),
        });
    }
    async recordExactApproval(approvalRef, binding) {
        if (!approvalPattern.test(approvalRef))
            throw new JobsError('exact private T007 approval is required');
        const key = privateCanaryDigest(approvalRef), scopeDigest = canaryFinalScopeDigest(binding);
        await this.locked(async (value) => {
            if (value.finalApprovals[key])
                throw new JobsError('exact private T007 approval already exists');
            value.finalApprovals[key] = { scopeDigest, consumed: false };
            await this.write(value);
        });
    }
    async consumeApprovalAndIssue(approvalRef, binding, expiresAt) {
        if (!approvalPattern.test(approvalRef) || !Number.isFinite(expiresAt.getTime())) {
            throw new JobsError('exact private T007 approval is required');
        }
        validateOracleCanaryBinding(binding);
        const capabilityRef = `canary_${randomBytes(32).toString('hex')}`;
        await this.locked(async (value) => {
            const approval = value.finalApprovals[privateCanaryDigest(approvalRef)];
            const capabilityDigest = privateCanaryDigest(capabilityRef);
            if (!approval || approval.consumed || approval.scopeDigest !== canaryFinalScopeDigest(binding)
                || value.attempts[capabilityDigest])
                throw new JobsError('exact private T007 approval is required');
            approval.consumed = true;
            value.attempts[capabilityDigest] = { bindingDigest: canaryBindingDigest(binding),
                expiresAt: expiresAt.toISOString(), attempted: false };
            await this.write(value);
        });
        return capabilityRef;
    }
    async consumeAttempt(capabilityRef, binding, now) {
        if (!capabilityPattern.test(capabilityRef) || !Number.isFinite(now.getTime()))
            throw new JobsError('canary capability is invalid');
        const exactBindingDigest = canaryBindingDigest(binding);
        const result = await this.locked(async (value) => {
            const attempt = value.attempts[privateCanaryDigest(capabilityRef)];
            if (!attempt || attempt.attempted)
                return 'unavailable';
            attempt.attempted = true;
            await this.write(value);
            if (attempt.bindingDigest !== exactBindingDigest)
                return 'binding_drift';
            return now.getTime() < Date.parse(attempt.expiresAt) ? 'authorized' : 'expired';
        });
        if (result !== 'authorized')
            throw new JobsError(result === 'expired' ? 'canary capability expired'
                : result === 'binding_drift' ? 'canary binding drifted' : 'canary capability is unavailable');
    }
}
export class OneAttemptCanaryAuthority {
    ledger;
    constructor(ledger) {
        this.ledger = ledger;
    }
    async issue(binding, approvalRef, now, ttlSeconds = 300) {
        if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300 || !Number.isFinite(now.getTime())) {
            throw new JobsError('canary expiry is invalid');
        }
        return this.ledger.consumeApprovalAndIssue(approvalRef, binding, new Date(now.getTime() + ttlSeconds * 1000));
    }
    attempt(capabilityRef, binding, now) {
        return this.ledger.consumeAttempt(capabilityRef, binding, now);
    }
}
