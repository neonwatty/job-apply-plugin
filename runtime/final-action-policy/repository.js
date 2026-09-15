import { access, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { withExclusiveFileLock } from '../store/exclusive-file-lock.js';
import { atomicWriteJsonFor } from '../store/atomic-write-json.js';
import { createNativeAtomicWriteIO, ensurePrivateDirectory } from '../store/private-filesystem.js';
import { linkLegacyContext } from '../contracts/persistence-exception.js';
import { APPLICATION_STATUSES, OUTCOMES, LEASE_DURATION, check, closed, decodePolicyBytes, digest, fingerprint, formatTime, newReference, object, parseAuthorization, parseReceipt, parsePolicyJson, parseTime, PolicyError, reference, serialization, serializeDocument, unique } from './model.js';
export const expandRoot = (root) => root === '~' ? homedir() : root.startsWith('~/') ? join(homedir(), root.slice(2)) : root;
export async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
export async function readDocument(path, label) {
    let value;
    try {
        value = parsePolicyJson(decodePolicyBytes(await readFile(path)));
    }
    catch {
        throw new PolicyError(`${label} is unavailable or invalid`);
    }
    return object(value, label);
}
/** Persistence primitives have no authority to call a final control. */
export class PolicyRepository {
    root;
    policyDir;
    campaignPath;
    archiveDir;
    applicationsDir;
    receiptsPath;
    lockPath;
    clock;
    newReference;
    io;
    provider;
    constructor(root, options) {
        this.root = expandRoot(root);
        this.policyDir = join(this.root, 'auto-submit');
        this.campaignPath = join(this.policyDir, 'campaign.json');
        this.archiveDir = join(this.policyDir, 'campaigns');
        this.applicationsDir = join(this.policyDir, 'applications');
        this.receiptsPath = join(this.policyDir, 'receipts.jsonl');
        this.lockPath = join(this.policyDir, '.lock');
        this.clock = options.clock ?? (() => new Date());
        this.newReference = options.newReference ?? newReference;
        this.io = options.atomicIO ?? createNativeAtomicWriteIO(serialization.pathProfile);
        this.provider = options.provider;
    }
    locked(operation) {
        const policy = () => withExclusiveFileLock(this.lockPath, operation, {
            provider: this.provider, pathProfile: serialization.pathProfile,
        });
        const storeLock = join(this.root, '.store.lock');
        return exists(storeLock).then(present => present
            ? withExclusiveFileLock(storeLock, async () => policy(), {
                provider: this.provider, pathProfile: serialization.pathProfile,
            })
            : policy());
    }
    privateDirectory(path) { return ensurePrivateDirectory(path, this.io); }
    writeDocument(path, value) {
        // Policy uses ensure_ascii=True; reuse the shared atomic state machine with its exact text.
        const document = serializeDocument(value);
        return atomicWriteJsonFor(path, [document.slice(0, -1)], '\n', this.io, linkLegacyContext);
    }
    campaignApplicationsDir(campaignId) {
        reference(campaignId, 'campaign', 'campaignId');
        return join(this.applicationsDir, campaignId.split(':')[1]);
    }
    applicationPath(applicationRef, campaignId) {
        reference(applicationRef, 'application', 'applicationRef');
        return join(this.campaignApplicationsDir(campaignId), `${applicationRef.split(':')[1]}.json`);
    }
    async loadApplication(applicationRef, campaignId) {
        const path = this.applicationPath(applicationRef, campaignId);
        check(await exists(path), 'application reservation does not exist');
        const application = parseApplication(await readDocument(path, 'application record'));
        check(application.campaignId === campaignId, 'application campaign does not match');
        check(application.applicationRef === applicationRef, 'application record does not match');
        return application;
    }
    async campaignApplications(campaignId) {
        const applications = [];
        for (const path of await this.applicationFiles(campaignId)) {
            const application = parseApplication(await readDocument(path, 'application record'));
            check(application.campaignId === campaignId, 'application campaign does not match');
            check(basename(path, '.json') === application.applicationRef.split(':')[1], 'application record path does not match');
            applications.push(application);
        }
        unique(applications, item => item.applicationRef, 'application reservations are not unique');
        unique(applications, item => String(item.slot), 'application reservations are not unique');
        check(applications.map(item => item.slot).sort((a, b) => a - b).every((slot, index) => slot === index + 1), 'application reservation slots are invalid');
        return applications;
    }
    newAttempt(number, now, campaignExpiry) {
        const expires = Math.min(now.getTime() + LEASE_DURATION, campaignExpiry);
        check(expires > now.getTime(), 'campaign is expired');
        return { attempt: number, leaseId: this.newReference('lease'), issuedAt: formatTime(now), expiresAt: formatTime(new Date(expires)),
            claimId: null, claimedAt: null, outcome: null, outcomeAt: null, confirmationRevision: null, receipt: null };
    }
    async applicationFiles(campaignId) {
        const directory = this.campaignApplicationsDir(campaignId);
        if (!await exists(directory))
            return [];
        return (await readdir(directory)).filter(name => name.endsWith('.json')).sort().map(name => join(directory, name));
    }
}
/** Validate the entire receipt/attempt relationship before any authority is used. */
export function parseApplication(value) {
    const item = object(value, 'application record');
    closed(item, ['schemaVersion', 'campaignId', 'applicationRef', 'slot', 'authorizationFingerprint', 'authorization', 'status', 'attempts', 'createdAt', 'updatedAt'], 'application record');
    check(item.schemaVersion === 1, 'application schema version is unsupported');
    reference(item.campaignId, 'campaign', 'campaignId');
    reference(item.applicationRef, 'application', 'applicationRef');
    check(Number.isSafeInteger(item.slot) && Number(item.slot) >= 1, 'application slot is invalid');
    const authorization = parseAuthorization(item.authorization);
    check(authorization.applicationRef === item.applicationRef, 'application authorization does not match');
    check(item.authorizationFingerprint === digest(authorization), 'application authorization fingerprint is invalid');
    check(typeof item.status === 'string' && APPLICATION_STATUSES.includes(item.status), 'application status is invalid');
    check(Array.isArray(item.attempts) && item.attempts.length >= 1 && item.attempts.length <= 2, 'application attempts are invalid');
    const attempts = item.attempts.map((value, index) => {
        const attempt = object(value, 'attempt');
        closed(attempt, ['attempt', 'leaseId', 'issuedAt', 'expiresAt', 'claimId', 'claimedAt', 'outcome', 'outcomeAt', 'confirmationRevision', 'receipt'], 'attempt');
        check(attempt.attempt === index + 1, 'attempt ordinal is invalid');
        reference(attempt.leaseId, 'lease', 'leaseId');
        const issued = parseTime(attempt.issuedAt), expires = parseTime(attempt.expiresAt);
        check(expires > issued && expires - issued <= LEASE_DURATION, 'attempt lease duration is invalid');
        check(attempt.outcome === null || typeof attempt.outcome === 'string' && OUTCOMES.includes(attempt.outcome), 'attempt outcome is invalid');
        if (attempt.claimId !== null)
            reference(attempt.claimId, 'claim', 'claimId');
        if (attempt.claimedAt !== null) {
            const claimed = parseTime(attempt.claimedAt);
            check(claimed >= issued && claimed < expires, 'attempt claim time is invalid');
        }
        check((attempt.claimId === null) === (attempt.claimedAt === null), 'attempt claim state is inconsistent');
        if (attempt.outcomeAt !== null)
            parseTime(attempt.outcomeAt);
        if (attempt.confirmationRevision !== null)
            fingerprint(attempt.confirmationRevision, 'confirmationRevision');
        if (attempt.receipt !== null) {
            const receipt = parseReceipt(attempt.receipt);
            check(receipt.campaignId === item.campaignId && receipt.applicationRef === item.applicationRef
                && receipt.slot === item.slot && receipt.attempt === index + 1 && receipt.leaseId === attempt.leaseId
                && receipt.claimId === attempt.claimId && receipt.outcome === attempt.outcome
                && receipt.confirmationRevision === attempt.confirmationRevision, 'attempt receipt does not match');
        }
        check((attempt.outcome === null) === (attempt.receipt === null), 'attempt receipt state is inconsistent');
        check(attempt.outcome === null || attempt.claimId !== null, 'unclaimed attempt cannot have an outcome');
        check((attempt.outcome === null) === (attempt.outcomeAt === null), 'attempt outcome time is inconsistent');
        if (attempt.outcome === 'confirmed_submitted')
            check(attempt.confirmationRevision !== null, 'confirmed attempt has no confirmation');
        else
            check(attempt.confirmationRevision === null, 'attempt confirmation is invalid');
        return attempt;
    });
    if (attempts.length === 2)
        check(attempts[0].outcome === 'uncertain', 'retry does not follow uncertainty');
    const last = attempts.at(-1);
    const stateValid = {
        lease_issued: last.outcome === null && last.claimId === null,
        action_claimed: last.outcome === null && last.claimId !== null,
        retry_available: attempts.length === 1 && last.outcome === 'uncertain',
        confirmed_submitted: last.outcome === 'confirmed_submitted',
        uncertain_exhausted: attempts.length === 2 && last.outcome === 'uncertain',
        blocked: last.outcome === 'blocked',
    };
    check(stateValid[item.status], 'application attempt state is inconsistent');
    parseTime(item.createdAt);
    parseTime(item.updatedAt);
    return structuredClone(item);
}
