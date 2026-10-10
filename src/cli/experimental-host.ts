import { experimentalResumeWorkflow } from './experimental-resume-workflow.js';
import { WorkflowArchiveError } from '../contracts/workspace/workflow-archive.js';
import { experimentalArchive } from './experimental-archive.js';
import { experimentalWorkflow } from './experimental-workflow.js';
import { experimentalClaimWorkflow } from './experimental-claim-workflow.js';
import { WorkflowError } from '../harness/contracts.js';
import { TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';

export type HostWorkflowResponse = { ok: true; result: unknown } | { ok: false; error: string };

/** Public composition for explicitly scoped synthetic trials on either model host. */
export async function experimentalHost(args: string[]): Promise<HostWorkflowResponse> {
  try {
    const [workflow, ...invocation] = args;
    if (workflow === 'resume') return { ok: true, result: await experimentalResumeWorkflow(invocation) };
    if (workflow === 'archive') return { ok: true, result: await experimentalArchive(invocation) };
    if (workflow === 'prepare') return { ok: true, result: await experimentalWorkflow(invocation) };
    if (workflow !== 'attempt') return { ok: false, error: 'invalid_invocation' };
    const response = await experimentalClaimWorkflow(invocation);
    if (!response || typeof response !== 'object' || !('ok' in response)) throw new Error('invalid response');
    // Broker errors are intentionally fixed and redacted; don't forward arbitrary socket data.
    if (response.ok !== true) return { ok: false, error: 'request_rejected' };
    return { ok: true, result: 'result' in response ? response.result : null };
  } catch (error) {
    return { ok: false, error: error instanceof WorkflowError || error instanceof TaskProtocolError
      ? error.code : error instanceof WorkflowArchiveError ? 'workflow_archive_corrupt' : 'workflow_failed' };
  }
}
