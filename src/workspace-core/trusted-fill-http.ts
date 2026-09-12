import { exact } from '../contracts/workspace/automation.js';
import { get, int, object, parse, serialize, JobsError } from '../contracts/workspace/values.js';
import type { TrustedFillRepository } from './trusted-fill.js';
import { TrustedFillService } from './trusted-fill.js';

export async function trustedFillHttp(repository: TrustedFillRepository, method: string, path: string, body: string) {
  const service = new TrustedFillService(repository);
  if (method === 'POST' && path === '/api/trusted-fill/approve') {
    return { status: 200, body: serialize(await service.approve(parse(body))) };
  }
  if (method === 'POST' && path === '/api/trusted-fill/evaluate') {
    return { status: 200, body: serialize(await service.evaluate(parse(body))) };
  }
  const match = /^\/api\/trusted-fill\/([^/]+?)(\/revoke)?$/.exec(path);
  if (!match) return null;
  const id = decodeURIComponent(match[1]!);
  if (method === 'GET' && !match[2]) return { status: 200, body: serialize(await service.status(id)) };
  if (method === 'POST' && match[2] === '/revoke') {
    const payload = object(parse(body), 'trusted fill revocation');
    exact(payload, ['expectedApprovalRevision'], 'trusted fill revocation contains unsupported fields');
    const revision = int(get(payload, 'expectedApprovalRevision'));
    if (revision === null || revision < 1n) throw new JobsError('expectedApprovalRevision must be a positive integer');
    return { status: 200, body: serialize(await service.revoke(id, revision)) };
  }
  return null;
}
