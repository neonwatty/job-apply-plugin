import { trustedFillNativePacket, validateTrustedFillNativeReceipt } from '../contracts/workspace/trusted-fill-native.js';
import { copy, fromJSON, get, int, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { TrustedFillService } from './trusted-fill.js';
export class TrustedFillNativeService {
    executor;
    authority;
    constructor(repository, executor, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.executor = executor;
        this.authority = new TrustedFillService(repository, now);
    }
    async execute(value) {
        if (!this.executor)
            throw new JobsError('native trusted fill provider injection is required');
        const evaluation = object(value, 'trusted fill native evaluation');
        const decision = object(await this.authority.evaluate(evaluation), 'trusted fill decision');
        if (get(decision, 'authorized') !== true)
            return decision;
        const packet = trustedFillNativePacket(evaluation, decision);
        const id = string(get(packet, 'jobId')), consumed = int(get(packet, 'consumedApprovalRevision'));
        let receipt;
        try {
            receipt = validateTrustedFillNativeReceipt(await this.executor.execute(copy(packet)), packet, this.executor.providerId);
        }
        catch {
            return this.authority.nativeOutcome(id, consumed, false);
        }
        const outcome = object(await this.authority.nativeOutcome(id, consumed, true), 'trusted fill native outcome');
        if (get(outcome, 'authorized') !== true)
            return outcome;
        const result = copy(outcome);
        set(result, 'providerId', text(this.executor.providerId));
        set(result, 'operationFingerprint', get(receipt, 'operationFingerprint'));
        set(result, 'appliedOperations', get(receipt, 'appliedOperations'));
        set(result, 'privateValuesCleared', fromJSON(true));
        return result;
    }
}
