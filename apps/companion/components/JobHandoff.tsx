import { useId } from 'react';
import type { ReactNode } from 'react';
import type { Job } from './contracts';
import { handoffActionLabels, recordedFormActions, type ActivityProjection } from './projection-model';
import { formatActivityTime, humanize, type ProjectionState } from './projection-view';

export function JobHandoff({job, activity, children}: {
  job: Job;
  activity: ProjectionState<ActivityProjection>;
  children?: ReactNode;
}) {
  const titleId = useId();
  const {data, loading, error, refresh} = activity;
  const matchesJob = data?.job.revision === job.revision && data.job.status === job.status;
  const session = matchesJob && !loading && !error && data.claim.state === 'none' ? data.session : null;
  const review = job.status === 'awaiting_review';
  const checked = session?.status === 'review' && session.reviewChecksRecorded
    && session.pending.length === 0 && session.blockers.length === 0 && session.handoffChecklist.length === 0;
  const blocked = job.status === 'needs_info' && session?.handoff === 'required';
  if (!review && !blocked) return null;

  const actions = blocked ? recordedFormActions(session) : [];
  const upload = actions.length === 1 && actions[0] === handoffActionLabels.resume_upload;
  const title = review
    ? checked ? 'Ready for your review' : loading ? 'Loading review details…' : 'Review details unavailable'
    : upload ? 'Attach resume in browser' : 'Browser action required';

  return <section className="workspace-panel job-handoff" aria-labelledby={titleId}>
    <p className="eyebrow">Application handoff</p>
    <h3 id={titleId}>{title}</h3>
    {checked && review ? <>
      <p>The agent reported that required fields were complete and stopped before submission.</p>
      <p>Return to your application tab to review the draft. Submit on the employer site when you’re ready.</p>
      <details open>
        <summary>Agent’s check{session.updatedAt !== 'Not recorded' && <> · {formatActivityTime(session.updatedAt)}</>}</summary>
        <ul>
          <li>Required fields reported complete</li>
          <li>No validation errors reported</li>
          {session.optionalUnansweredControlIds.length > 0 && <li>
            <span>Optional fields left blank</span>
            <ul>{session.optionalUnansweredControlIds.map(id => <li key={id}>{humanize(id).replaceAll('.', ' ')}</li>)}</ul>
          </li>}
        </ul>
      </details>
    </> : review ? <>
      {loading ? <p role="status">Checking the saved application activity.</p>
        : <p>{error ? 'The latest review checks could not be loaded.' : !matchesJob && data
          ? 'This job has changed. Refresh the saved job before relying on its review details.'
          : 'Companion has an awaiting-review status for this job. Recorded checks for this handoff are unavailable.'} Check the draft in your application tab.</p>}
      {error && <button type="button" onClick={refresh}>Retry loading review details</button>}
    </> : <>
      <p>{upload ? 'Return to your application tab and attach your resume. Then tell the agent to continue.'
        : 'Return to your application tab to complete the remaining browser steps. Then tell the agent to continue.'}</p>
      {!upload && actions.length > 0 && <ul>{actions.map(action => <li key={action}>{action}</li>)}</ul>}
      {session && session.updatedAt !== 'Not recorded' && <p className="focus-footnote">Last recorded update · {formatActivityTime(session.updatedAt)}</p>}
    </>}
    {children}
  </section>;
}
