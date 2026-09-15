import { createHmac } from 'node:crypto';
import { CampaignPolicy, campaignMode } from './campaigns.js';
import { exists, parseApplication } from './repository.js';
import { RULE_FIELDS, canonical, check, confirmationAuthorityRevision, digest, formatTime, parseAuthorization, parseTime, reference } from './model.js';
import type { Application, Authorization, Campaign, Claim } from './model.js';

export type ReviewDecision = { mode: 'review_only'; reason: string };
export interface LeaseDecision {
  mode: 'auto_submit';
  reason: 'exact_policy_lease';
  campaignId: string;
  applicationRef: string;
  slot: number;
  attempt: number;
  leaseId: string;
  leaseExpiresAt: string;
}
export type Activation = (claim: Claim) => void | Promise<void>;
export function authorizationMismatch(campaign: Campaign, authorization: Authorization): string | null {
  const rules = campaign.applicationRules.filter(rule => rule.applicationRef === authorization.applicationRef);
  const selected = Object.fromEntries(RULE_FIELDS.map(field => [field, authorization[field as keyof Authorization]]));
  if (rules.length !== 1 || canonical(rules[0]) !== canonical(selected)) return 'scope_mismatch';
  if (authorization.resumeRevision !== campaign.resumeRevision) return 'resume_mismatch';
  const allowed = new Map(campaign.sensitiveAllowlist.map(item => [item.answerRef, item]));
  if (authorization.answerRevisions.some(item => !allowed.has(item.answerRef) || canonical(allowed.get(item.answerRef)) !== canonical(item))) return 'sensitive_scope_mismatch';
  return null;
}
function authorizationResult(application: Application): LeaseDecision {
  const attempt = application.attempts.at(-1)!;
  return { mode: 'auto_submit', reason: 'exact_policy_lease', campaignId: application.campaignId, applicationRef: application.applicationRef,
    slot: application.slot, attempt: attempt.attempt, leaseId: attempt.leaseId, leaseExpiresAt: attempt.expiresAt };
}
export class AuthorizationPolicy extends CampaignPolicy {
  async authorize(incoming: unknown): Promise<ReviewDecision | LeaseDecision> {
    const now = this.clock();
    let authorization: Authorization;
    try { authorization = parseAuthorization(incoming); }
    catch { return { mode: 'review_only', reason: 'authorization_invalid' }; }
    return this.locked(async () => {
      try {
        const campaign = await this.loadCampaign();
        const decision = campaignMode(campaign, now);
        if (decision.mode !== 'auto_submit') return { mode: 'review_only', reason: decision.reason };
        const mismatch = authorizationMismatch(campaign, authorization);
        if (mismatch) return { mode: 'review_only', reason: mismatch };
        const path = this.applicationPath(authorization.applicationRef, campaign.campaignId);
        const authorizationFingerprint = digest(authorization);
        if (await exists(path)) {
          const application = await this.loadApplication(authorization.applicationRef, campaign.campaignId);
          if (application.authorizationFingerprint !== authorizationFingerprint) return { mode: 'review_only', reason: 'authorization_changed' };
          if (application.status === 'lease_issued') {
            if (now.getTime() >= parseTime(application.attempts.at(-1)!.expiresAt)) return { mode: 'review_only', reason: 'lease_expired' };
            return authorizationResult(application);
          }
          if (application.status === 'retry_available') {
            application.attempts.push(this.newAttempt(2, now, parseTime(campaign.expiresAt)));
            application.status = 'lease_issued';
            application.updatedAt = formatTime(now);
            await this.writeDocument(path, parseApplication(application));
            return authorizationResult(application);
          }
          return { mode: 'review_only', reason: application.status };
        }
        const applications = await this.campaignApplications(campaign.campaignId);
        const reserved = applications.length;
        if (campaign.reservedApplications !== reserved) {
          campaign.reservedApplications = reserved;
          await this.writeDocument(this.campaignPath, campaign);
        }
        if (reserved >= campaign.maxApplications) return { mode: 'review_only', reason: 'application_limit' };
        const slot = reserved + 1;
        const application = parseApplication({ schemaVersion: 1, campaignId: campaign.campaignId, applicationRef: authorization.applicationRef,
          slot, authorizationFingerprint, authorization, status: 'lease_issued', attempts: [this.newAttempt(1, now, parseTime(campaign.expiresAt))],
          createdAt: formatTime(now), updatedAt: formatTime(now) });
        await this.privateDirectory(this.campaignApplicationsDir(campaign.campaignId));
        await this.writeDocument(path, application);
        campaign.reservedApplications = slot;
        await this.writeDocument(this.campaignPath, campaign);
        return authorizationResult(application);
      } catch { return { mode: 'review_only', reason: 'policy_unavailable' }; }
    });
  }
  async claim(applicationRef: string, leaseId: string, attemptOrdinal: number, observedAuthorization: unknown,
    actionCapability?: string, activation?: Activation): Promise<Claim> {
    const now = this.clock();
    reference(applicationRef, 'application', 'applicationRef');
    reference(leaseId, 'lease', 'leaseId');
    check(Number.isSafeInteger(attemptOrdinal) && [1, 2].includes(attemptOrdinal), 'attempt ordinal is invalid');
    const authorization = parseAuthorization(observedAuthorization);
    check(authorization.applicationRef === applicationRef, 'observed authorization does not match');
    return this.locked(async () => {
      const campaign = await this.loadCampaign();
      const decision = campaignMode(campaign, now);
      check(decision.mode === 'auto_submit', `final action is not authorized: ${decision.reason}`);
      const mismatch = authorizationMismatch(campaign, authorization);
      check(mismatch === null, `final action is not authorized: ${mismatch}`);
      check(confirmationAuthorityRevision(actionCapability) === campaign.confirmationAuthorityRevision, 'final action capability does not match campaign');
      const application = await this.loadApplication(applicationRef, campaign.campaignId);
      check(application.authorizationFingerprint === digest(authorization), 'final action is not authorized: authorization_changed');
      const attempt = application.attempts.at(-1)!;
      check(application.status === 'lease_issued', 'final action lease is already claimed or consumed');
      check(attempt.attempt === attemptOrdinal && attempt.leaseId === leaseId, 'final action lease is stale');
      check(attempt.outcome === null && attempt.claimId === null, 'final action lease is already claimed or consumed');
      check(now.getTime() < parseTime(attempt.expiresAt), 'final action lease is expired');
      const claimId = this.newReference('claim');
      const claimProof = createHmac('sha256', actionCapability!).update(claimId).digest('hex');
      attempt.claimId = claimId;
      attempt.claimedAt = formatTime(now);
      application.status = 'action_claimed';
      application.updatedAt = formatTime(now);
      await this.writeDocument(this.applicationPath(applicationRef, campaign.campaignId), parseApplication(application));
      const claim: Claim = { mode: 'auto_submit', reason: 'atomic_action_claim', campaignId: campaign.campaignId,
        applicationRef: application.applicationRef, slot: application.slot, attempt: attemptOrdinal, claimId, claimProof };
      // Durable consumption precedes activation; callback rejection cannot restore authority.
      // The informational claimProof is never accepted as confirmation or a repeat grant.
      if (activation) await activation({ ...claim });
      return claim;
    });
  }
}
