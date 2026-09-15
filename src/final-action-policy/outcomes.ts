import { constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createNativeJsonlHistoryIO } from '../store/jsonl-history-io.js';
import { AuthorizationPolicy } from './authorization.js';
import { exists, parseApplication } from './repository.js';
import { OUTCOMES, check, decodePolicyBytes, fingerprint, formatTime, object, parseConfirmation, parseReceipt, parsePolicyJson, parseTime, PolicyError, reference, serialization, serializeReceiptLine } from './model.js';
import type { Receipt } from './model.js';

export class OutcomePolicy extends AuthorizationPolicy {
  private async receiptIsLogged(receiptId: string): Promise<boolean> {
    if (!await exists(this.receiptsPath)) return false;
    let lines: string[];
    try { lines = (decodePolicyBytes(await readFile(this.receiptsPath))).split(/\r?\n/); }
    catch { throw new PolicyError('receipt log is unavailable or invalid'); }
    for (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = parsePolicyJson(line); }
      catch { throw new PolicyError('receipt log is unavailable or invalid'); }
      const receipt = parseReceipt(value);
      if (receipt.receiptId === receiptId) return true;
    }
    return false;
  }
  protected async ensureReceiptLogged(receipt: Receipt): Promise<void> {
    if (await this.receiptIsLogged(receipt.receiptId)) return;
    parseReceipt(receipt);
    await this.privateDirectory(this.policyDir);
    const encoded = serializeReceiptLine(receipt);
    // Policy's Python append is deliberately a single write, without journal rollback.
    const io = createNativeJsonlHistoryIO(serialization.pathProfile);
    const handle = await io.open(this.receiptsPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
    try {
      check(await handle.write(encoded) === encoded.length, 'receipt append was incomplete');
      await handle.sync();
    } finally { await handle.close(); }
  }
  async outcome(campaignId: string, applicationRef: string, leaseId: string, claimId: string, outcome: string,
    confirmationEvent?: unknown, confirmationCapability?: string): Promise<Receipt> {
    const now = this.clock();
    reference(campaignId, 'campaign', 'campaignId');
    reference(applicationRef, 'application', 'applicationRef');
    reference(leaseId, 'lease', 'leaseId');
    reference(claimId, 'claim', 'claimId');
    check(OUTCOMES.includes(outcome), 'outcome is unsupported');
    if (outcome === 'confirmed_submitted') {
      check(confirmationEvent !== null && typeof confirmationEvent === 'object' && !Array.isArray(confirmationEvent), 'trusted confirmation event is required');
    } else check(confirmationEvent == null && confirmationCapability == null, 'confirmation evidence is only valid for confirmed submission');
    return this.locked(async () => {
      const campaign = await this.loadCampaignById(campaignId);
      const application = await this.loadApplication(applicationRef, campaign.campaignId);
      const confirmation = outcome === 'confirmed_submitted'
        ? parseConfirmation(confirmationEvent, claimId, campaign.confirmationAuthorityRevision, confirmationCapability) : null;
      const confirmationRevision = confirmation ? fingerprint(confirmation.confirmationRevision, 'confirmationRevision') : null;
      check(application.campaignId === campaign.campaignId, 'application campaign does not match');
      const attempt = application.attempts.at(-1)!;
      check(attempt.leaseId === leaseId, 'lease is stale or already consumed');
      check(attempt.claimId === claimId, 'action claim is stale or invalid');
      if (confirmation) check(parseTime(confirmation.observedAt) >= parseTime(attempt.claimedAt) && parseTime(confirmation.observedAt) <= now.getTime(), 'confirmation event time is invalid');
      if (attempt.outcome !== null) {
        check(attempt.outcome === outcome && attempt.confirmationRevision === confirmationRevision, 'lease is stale or already consumed');
        const receipt = parseReceipt(object(attempt.receipt, 'receipt'));
        await this.ensureReceiptLogged(receipt);
        return receipt;
      }
      check(application.status === 'action_claimed', 'application has no active action claim');
      const status = outcome === 'confirmed_submitted' ? 'confirmed_submitted' : outcome === 'blocked' ? 'blocked' : attempt.attempt === 1 ? 'retry_available' : 'uncertain_exhausted';
      const receipt = parseReceipt({ schemaVersion: 1, receiptId: this.newReference('receipt'), campaignId: campaign.campaignId,
        applicationRef, slot: application.slot, attempt: attempt.attempt, leaseId, claimId, outcome, status, at: formatTime(now), confirmationRevision });
      attempt.outcome = receipt.outcome;
      attempt.outcomeAt = formatTime(now);
      attempt.confirmationRevision = confirmationRevision;
      attempt.receipt = receipt;
      application.status = status;
      application.updatedAt = formatTime(now);
      await this.writeDocument(this.applicationPath(applicationRef, campaign.campaignId), parseApplication(application));
      await this.ensureReceiptLogged(receipt);
      return receipt;
    });
  }
}
