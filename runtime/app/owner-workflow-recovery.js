import { validateReviewRestartEvidence } from '../contracts/workspace/review-restart.js';
import { has, truth, string, int, get } from '../contracts/workspace/values.js';
import { isJobWorkflowTask, TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';
import { attemptIdentity } from '../workflows/applications/attempt.js';
import { preparationScope } from '../workflows/applications/prepare-scope.js';
/** Existing workflow attempts retain their exact inputs. A first owner attempt may
 * adopt a modern canonical review produced by the ordinary broker; that review
 * is a restart checkpoint, never browser evidence for the new attempt.
 */
export function requireOwnerReviewScope(snapshot, ledger, job, jobId) {
    const revision = int(get(job, 'revision')).toString();
    const related = Object.values(ledger.tasks).filter(task => isJobWorkflowTask(task) && task.subject.jobId === jobId);
    if (ledger.activeTaskId === null && related.length === 0) {
        const session = snapshot.sessions.find(item => string(get(item, 'applicationId')) === jobId);
        // Legacy reviews have no current-attempt readiness envelope to adopt.
        if (session && has(session, 'attemptRevision') && has(session, 'readiness')
            && !truth(get(session, 'handoffChecklist'))
            && validateReviewRestartEvidence(job, session, snapshot.history) === 'job-restarted')
            return;
        throw new TaskProtocolError('action_unavailable');
    }
    const candidates = related.filter(task => isJobWorkflowTask(task)
        && task.workflow.id === attemptIdentity.id && task.workflow.version === attemptIdentity.version
        && task.status === 'finished' && task.subject.jobId === jobId && task.subject.jobRevision === revision);
    if (ledger.activeTaskId !== null || candidates.length !== 1
        || candidates[0].subject.inputRevision !== preparationScope(snapshot, job)) {
        throw new TaskProtocolError('action_unavailable');
    }
}
