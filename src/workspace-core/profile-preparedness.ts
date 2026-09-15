import { get, object, string, truth, fromJSON } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import { PythonObject } from '../contracts/python-object.js';

export interface PreparednessSnapshot {
  profile: Value;
  provenance: Value;
  resumes: Array<{ id: string; default: boolean; deletedAt: string | null; storageKind: string; digest?: string | null }>;
  observeResume(record: PreparednessSnapshot['resumes'][number]): Promise<{ exists: boolean; digest: string | null }>;
  requests: Array<{ status: string; resumeId: string; requestId: string; failureReason?: string }>;
  proposals: Array<{ status: string; resumeId: string; id: string; pendingPaths: string[] }>;
}
export interface PreparednessRepository { preparednessSnapshot(): Promise<PreparednessSnapshot>; }

function meaningful(value: Value): boolean {
  if (value === null) return false;
  if (string(value) !== null) return Boolean(string(value)!.trim());
  if (Array.isArray(value)) return value.some(meaningful);
  if (value instanceof PythonObject) return value.entries().some(([, item]) => meaningful(item));
  return truth(value);
}
function userProtects(provenance: Document, path: string): boolean {
  for (const [key, value] of provenance.entries()) {
    const pointer = string(key)!;
    if ((path === pointer || path.startsWith(`${pointer}/`) || pointer.startsWith(`${path}/`))
      && string(get(object(value, 'provenance'), 'source')) === 'user') return true;
  }
  return false;
}

export class PreparednessService {
  constructor(readonly repository: PreparednessRepository) {}
  async get(): Promise<Value> {
    const snapshot = await this.repository.preparednessSnapshot();
    const profile = object(snapshot.profile, 'profile'), provenance = object(snapshot.provenance, 'profile fact provenance');
    const essentialSetup = [['first_name', 'firstName'], ['last_name', 'lastName'], ['email', 'email']].map(([id, key]) => {
      const present = meaningful(get(profile, key!));
      return { id, paths: [`/${key}`], state: present ? 'present' : 'blocked', reasonCode: present ? null : `${id}_missing` };
    });
    const resume = snapshot.resumes.find(item => item.default && item.deletedAt === null);
    const resumeItem: Record<string, unknown> = { id: 'default_resume', state: 'blocked', reasonCode: 'default_resume_missing' };
    if (resume) {
      resumeItem.resumeId = resume.id;
      if (resume.storageKind !== 'managed') resumeItem.reasonCode = 'default_resume_unreadable';
      else {
        const observed = await snapshot.observeResume(resume);
        if (!observed.exists) resumeItem.reasonCode = 'default_resume_unreadable';
        else if (observed.digest !== resume.digest) resumeItem.reasonCode = 'default_resume_changed';
        else { resumeItem.state = 'present'; resumeItem.reasonCode = null; }
      }
    }
    essentialSetup.push(resumeItem as never);
    const groups: Array<[string, string[]]> = [
      ['phone', ['phone']], ['location', ['location']], ['work_history', ['workHistory']],
      ['education', ['education']], ['skills', ['skills']],
      ['professional_links', ['linkedInUrl', 'portfolioUrl', 'githubUrl']],
    ];
    const commonCoverage = groups.map(([id, fields]) => {
      const present = fields.some(key => meaningful(get(profile, key)));
      return { id, paths: fields.map(key => `/${key}`), state: present ? 'present' : 'not_present', reasonCode: present ? null : `${id}_missing` };
    });
    const reviewHealth: Array<Record<string, unknown>> = [];
    for (const request of snapshot.requests) if (['requested', 'failed', 'stale'].includes(request.status)) {
      const item: Record<string, unknown> = { kind: 'extraction_request', reasonCode: `extraction_${request.status}`,
        resumeId: request.resumeId, requestId: request.requestId };
      if (request.status === 'failed') item.failureReason = request.failureReason;
      reviewHealth.push(item);
    }
    for (const proposal of snapshot.proposals) if (proposal.status === 'pending' && proposal.pendingPaths.length) {
      reviewHealth.push({ kind: 'resume_proposal', reasonCode: 'unresolved_conflicts', resumeId: proposal.resumeId,
        proposalId: proposal.id, count: proposal.pendingPaths.length });
      const count = proposal.pendingPaths.filter(path => userProtects(provenance, path)).length;
      if (count) reviewHealth.push({ kind: 'resume_proposal', reasonCode: 'human_protected_facts_retained',
        resumeId: proposal.resumeId, proposalId: proposal.id, count });
    }
    reviewHealth.sort((a, b) => {
      const left = `${a.kind}\0${a.reasonCode}\0${a.requestId ?? a.proposalId ?? ''}`;
      const right = `${b.kind}\0${b.reasonCode}\0${b.requestId ?? b.proposalId ?? ''}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return fromJSON({ essentialSetup, commonCoverage, reviewHealth });
  }
}
