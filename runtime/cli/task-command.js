import { WorkspaceProjectionsService } from '../workspace-core/workspace-projections.js';
import { TaskIntakeService } from '../workspace-core/task-intake.js';
import { ClaimsService } from '../workspace-core/claims.js';
import { PendingAnswersService } from '../workspace-core/pending-answers.js';
import { AnswersService } from '../workspace-core/answers.js';
import { AnswerMergeService } from '../workspace-core/answer-merges.js';
import { GroupedApprovalsService } from '../workspace-core/grouped-approvals.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { get, keys, object, set, text } from '../contracts/workspace/values.js';
import { parseTaskRevision, TaskRequestError } from './task-protocol.js';
/** Adapt task protocol envelopes to the existing locked native services. */
export async function runTaskCommand(parsed, repository, payload) {
    const { command, options, ownerConfirmed } = parsed;
    const option = (name) => options.get(name);
    const revision = (name) => parseTaskRevision(option(name));
    const result = set(set(emptyObject(), 'ok', true), 'command', text(command));
    if (command === 'snapshot')
        return set(result, 'snapshot', await new WorkspaceProjectionsService(repository).taskSnapshot());
    if (command === 'activity') {
        set(result, 'jobId', text(option('--id')));
        return set(result, 'activity', await new WorkspaceProjectionsService(repository).activity(option('--id')));
    }
    let operation;
    switch (command) {
        case 'intake':
            operation = await new TaskIntakeService(repository).intake(await payload(), 'agent');
            break;
        case 'select':
            operation = await new ClaimsService(repository).select(option('--id'), revision('--expected-revision'), ownerConfirmed);
            break;
        case 'resolve-pending-answer':
            operation = await new PendingAnswersService(repository).resolve(option('--id'), option('--reference'), revision('--expected-job-revision'), revision('--expected-session-revision'), revision('--expected-answer-revision'), ownerConfirmed);
            break;
        case 'semantic-lookup':
            operation = await new AnswersService(repository).semanticLookup(await payload());
            break;
        case 'cleanup-preview':
            operation = await new AnswersService(repository).cleanupPreview();
            break;
        case 'cleanup-approve':
            operation = await new AnswerMergeService(repository).approve(await payload(), ownerConfirmed);
            break;
        case 'approval-preview':
        case 'approval-approve': {
            const incoming = await payload();
            if (keys(incoming).length !== 1 || !Array.isArray(get(incoming, 'decisions')))
                throw new TaskRequestError();
            const service = new GroupedApprovalsService(repository);
            const args = [option('--id'), revision('--expected-job-revision'), revision('--expected-session-revision'), get(incoming, 'decisions')];
            operation = command === 'approval-preview' ? await service.preview(...args)
                : await service.approve(...args, option('--preview-token'), ownerConfirmed);
            break;
        }
        default: throw new TaskRequestError();
    }
    for (const [key, value] of object(operation, 'task result').entries())
        result.set(key, value);
    return result;
}
