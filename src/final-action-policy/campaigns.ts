import { join } from 'node:path';
import { PolicyRepository, exists, readDocument } from './repository.js';
import { check, closed, fingerprint, formatTime, MAX_DURATION, object, parseRule, parseSensitive, parseTime, reference, canonical, unique } from './model.js';
import type { Campaign } from './model.js';

export function parseCampaign(value: unknown): Campaign {
  const campaign = object(value, 'campaign');
  closed(campaign, ['schemaVersion', 'campaignId', 'mode', 'status', 'createdAt', 'expiresAt', 'maxApplications', 'applicationRules', 'resumeRevision', 'sensitiveAllowlist', 'confirmationAuthorityRevision', 'riskAcknowledgedAt', 'killSwitch', 'killSwitchAt', 'reservedApplications'], 'campaign');
  check(campaign.schemaVersion === 1, 'campaign schema version is unsupported');
  reference(campaign.campaignId, 'campaign', 'campaignId');
  check(campaign.mode === 'auto_submit', 'campaign mode is invalid');
  check(typeof campaign.status === 'string' && ['active', 'revoked', 'killed', 'expired'].includes(campaign.status), 'campaign status is invalid');
  const created = parseTime(campaign.createdAt), expires = parseTime(campaign.expiresAt);
  check(expires > created && expires - created <= MAX_DURATION, 'campaign duration is invalid');
  check(Number.isSafeInteger(campaign.maxApplications) && Number(campaign.maxApplications) >= 1 && Number(campaign.maxApplications) <= 10, 'campaign application limit is invalid');
  check(Array.isArray(campaign.applicationRules) && campaign.applicationRules.length > 0, 'campaign requires application rules');
  const rules = campaign.applicationRules.map(parseRule);
  unique(rules, rule => rule.applicationRef, 'campaign application rules contain duplicates');
  fingerprint(campaign.resumeRevision, 'resumeRevision');
  fingerprint(campaign.confirmationAuthorityRevision, 'confirmationAuthorityRevision');
  check(Array.isArray(campaign.sensitiveAllowlist), 'sensitiveAllowlist must be a list');
  const allowlist = campaign.sensitiveAllowlist.map(parseSensitive);
  unique(allowlist, item => item.answerRef, 'sensitiveAllowlist contains duplicates');
  parseTime(campaign.riskAcknowledgedAt);
  check(typeof campaign.killSwitch === 'boolean', 'campaign kill switch is invalid');
  if (campaign.killSwitchAt !== null) parseTime(campaign.killSwitchAt);
  check(campaign.killSwitch === (campaign.status === 'killed'), 'campaign kill switch state is inconsistent');
  check(campaign.killSwitch === (campaign.killSwitchAt !== null), 'campaign kill switch timestamp is inconsistent');
  check(Number.isSafeInteger(campaign.reservedApplications) && Number(campaign.reservedApplications) >= 0 && Number(campaign.reservedApplications) <= Number(campaign.maxApplications), 'campaign reservation count is invalid');
  return structuredClone(campaign) as unknown as Campaign;
}
export function campaignMode(campaign: Campaign, now: Date): { mode: 'review_only' | 'auto_submit'; reason: string } {
  if (campaign.killSwitch) return { mode: 'review_only', reason: 'kill_switch' };
  if (campaign.status !== 'active') return { mode: 'review_only', reason: campaign.status };
  if (now.getTime() >= parseTime(campaign.expiresAt)) return { mode: 'review_only', reason: 'expired' };
  return { mode: 'auto_submit', reason: 'active_campaign' };
}
export class CampaignPolicy extends PolicyRepository {
  protected async loadCampaign(): Promise<Campaign> {
    check(await exists(this.campaignPath), 'campaign does not exist');
    return parseCampaign(await readDocument(this.campaignPath, 'campaign'));
  }
  protected async loadCampaignById(campaignId: string): Promise<Campaign> {
    reference(campaignId, 'campaign', 'campaignId');
    const current = await this.loadCampaign();
    if (current.campaignId === campaignId) return current;
    const path = join(this.archiveDir, `${campaignId.split(':')[1]}.json`);
    check(await exists(path), 'campaign does not exist');
    const archived = parseCampaign(await readDocument(path, 'campaign archive'));
    check(archived.campaignId === campaignId, 'campaign archive does not match');
    return archived;
  }
  async status(): Promise<{ mode: string; reason: string; campaignId: string | null }> {
    // Python status is a pure observation, never a grant and never a writer.
    try {
      const campaign = await this.loadCampaign();
      const decision = campaignMode(campaign, this.clock());
      return { ...decision, campaignId: decision.mode === 'auto_submit' ? campaign.campaignId : null };
    } catch { return { mode: 'review_only', reason: 'policy_unavailable', campaignId: null }; }
  }
  async activate(value: unknown): Promise<Campaign> {
    const incoming = object(value, 'campaign input');
    const now = this.clock();
    const allowed = ['riskAcknowledged', 'applicationRules', 'resumeRevision', 'sensitiveAllowlist', 'confirmationAuthorityRevision', 'maxApplications', 'durationSeconds'];
    check(Object.keys(incoming).every(key => allowed.includes(key)), 'campaign input contains unsupported fields');
    check(incoming.riskAcknowledged === true, 'explicit risk acknowledgement is required');
    check(Array.isArray(incoming.applicationRules) && incoming.applicationRules.length > 0, 'campaign requires application rules');
    const rules = incoming.applicationRules.map(parseRule);
    const duration = Object.hasOwn(incoming, 'durationSeconds') ? incoming.durationSeconds : MAX_DURATION / 1000;
    check(Number.isSafeInteger(duration) && Number(duration) >= 1 && Number(duration) <= MAX_DURATION / 1000, 'campaign duration is invalid');
    const campaign = parseCampaign({ schemaVersion: 1, campaignId: this.newReference('campaign'), mode: 'auto_submit', status: 'active',
      createdAt: formatTime(now), expiresAt: formatTime(new Date(now.getTime() + Number(duration) * 1000)),
      maxApplications: Object.hasOwn(incoming, 'maxApplications') ? incoming.maxApplications : 10,
      applicationRules: rules, resumeRevision: fingerprint(incoming.resumeRevision, 'resumeRevision'),
      sensitiveAllowlist: Object.hasOwn(incoming, 'sensitiveAllowlist') ? incoming.sensitiveAllowlist : [],
      confirmationAuthorityRevision: fingerprint(incoming.confirmationAuthorityRevision, 'confirmationAuthorityRevision'),
      riskAcknowledgedAt: formatTime(now), killSwitch: false, killSwitchAt: null, reservedApplications: 0 });
    return this.locked(async () => {
      if (await exists(this.campaignPath)) {
        const previous = await this.loadCampaign();
        check(campaignMode(previous, now).mode !== 'auto_submit' && !previous.killSwitch, 'an active or killed campaign cannot be replaced');
        await this.privateDirectory(this.archiveDir);
        const path = join(this.archiveDir, `${previous.campaignId.split(':')[1]}.json`);
        if (await exists(path)) {
          const archived = parseCampaign(await readDocument(path, 'campaign archive'));
          check(canonical(archived) === canonical(previous), 'campaign archive already exists');
        } else await this.writeDocument(path, previous);
      }
      await this.writeDocument(this.campaignPath, campaign);
      return campaign;
    });
  }
  private async stop(status: 'killed' | 'revoked', kill: boolean): Promise<{ mode: string; reason: string; campaignId: string }> {
    const now = this.clock();
    return this.locked(async () => {
      const campaign = await this.loadCampaign();
      check(!campaign.killSwitch || kill, 'kill switch cannot be cleared by revocation');
      campaign.status = status;
      campaign.killSwitch = kill;
      campaign.killSwitchAt = kill ? formatTime(now) : null;
      await this.writeDocument(this.campaignPath, parseCampaign(campaign));
      return { mode: 'review_only', reason: status, campaignId: campaign.campaignId };
    });
  }
  kill(): Promise<{ mode: string; reason: string; campaignId: string }> { return this.stop('killed', true); }
  revoke(): Promise<{ mode: string; reason: string; campaignId: string }> { return this.stop('revoked', false); }
}
