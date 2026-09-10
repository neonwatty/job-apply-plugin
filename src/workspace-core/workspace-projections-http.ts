import { WorkspaceProjectionsService } from './workspace-projections.js';
import type { ClaimRepository } from './claims.js';
import { serialize } from '../contracts/workspace/values.js';

/** The authenticated adapter owns route, request and response bounds. */
export async function workspaceProjectionsHttp(repository: ClaimRepository, method: string, path: string): Promise<{status:number;body:string}|null> {
  if (method !== 'GET') return null;
  const service = new WorkspaceProjectionsService(repository);
  if (path === '/api/overview') return {status:200,body:serialize(await service.overview())};
  if (path === '/api/attention') return {status:200,body:serialize(await service.attention())};
  const match = /^\/api\/jobs\/([^/]+)\/(activity|preflight)$/.exec(path);
  if (!match) return null;
  const id = decodeURIComponent(match[1]!);
  return {status:200,body:serialize(await (match[2] === 'activity' ? service.activity(id) : service.preflight(id)))};
}
