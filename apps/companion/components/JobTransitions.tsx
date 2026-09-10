'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { Client } from './client';
import type { Job } from './contracts';
import { closedOutcomes, transitionAcknowledgement, transitionBody, transitionConfirmation,
  transitionFailure, transitionTargets, type TransitionTarget } from './job-transition-model';

const labels: Record<TransitionTarget, string> = {
  saved: 'Mark saved', needs_info: 'Mark needs info', ready: 'Mark ready',
  awaiting_review: 'Mark awaiting review', applied: 'Mark applied', closed: 'Close job',
};
export function JobTransitions({ client, job, disabled, onBusyChanged, onChanged }: {
  client: Client;
  job: Job;
  disabled: boolean;
  onBusyChanged: (busy: boolean) => void;
  onChanged: (job: Job) => void;
}) {
  const headingId = useId();
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const currentJobId = useRef(job.id);
  const busyChanged = useRef(onBusyChanged);
  currentJobId.current = job.id;
  busyChanged.current = onBusyChanged;
  useEffect(() => {
    setOutcome('');
    setError('');
    setNotice('');
    setBusy(false);
    return () => {
      generation.current++;
      if (request.current) {
        request.current.abort();
        request.current = null;
        busyChanged.current(false);
      }
    };
  }, [job.id]);

  async function transition(status: TransitionTarget) {
    if (disabled || request.current) return;
    let body: string;
    try { body = transitionBody(job, status, outcome, status === 'applied'); }
    catch (failure) { setError(transitionFailure(failure)); return; }
    if (!window.confirm(transitionConfirmation(job, status, outcome))) return;
    const controller = new AbortController();
    const version = ++generation.current;
    const base = job;
    request.current = controller;
    setBusy(true);
    busyChanged.current(true);
    setError('');
    setNotice('');
    const alive = () => version === generation.current && currentJobId.current === base.id && !controller.signal.aborted;
    function release() {
      request.current = null;
      setBusy(false);
      busyChanged.current(false);
    }
    try {
      const raw = await client.extractionRequest(`/api/jobs/${encodeURIComponent(base.id)}/transition`, 'POST', body, controller.signal);
      if (!alive()) return;
      const next = transitionAcknowledgement(raw, base, status);
      release();
      setNotice(`Local status changed to ${status.replaceAll('_', ' ')}.`);
      onChanged(next);
    } catch (failure) {
      if (!alive()) return;
      release();
      setError(transitionFailure(failure));
    }
  }
  const targets = transitionTargets(job);
  return <section aria-labelledby={headingId} aria-busy={busy}>
    <h3 id={headingId}>Job status</h3>
    <p>Current status: {job.status.replaceAll('_', ' ')}. These actions update the local record only. Final application submission stays manual.</p>
    {targets.includes('ready') && <p>Mark ready runs preflight checks for the job, profile, and resume.</p>}
    {job.status === 'in_progress' && <p>After an active claim is released, mark needs info to recover a job that needs more work.</p>}
    {disabled && <p>Finish or save current work and refresh any changed values before changing status. Active claims must be released first.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">Updating local status…</p>}
    <fieldset disabled={disabled || busy} style={{ minWidth: 0 }}>
      <legend>Change local status</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {targets.filter(target => target !== 'closed').map(target => <button
          key={target} type="button" onClick={() => void transition(target)}>
          {target === 'saved' && job.status === 'closed' ? 'Reopen as saved' : labels[target]}
        </button>)}
      </div>
      {targets.includes('closed') && <div>
        <label>Closing outcome
          <select value={outcome} onChange={event => setOutcome(event.target.value)}>
            <option value="">Choose an outcome</option>
            {closedOutcomes.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
          </select>
        </label>
        <button type="button" disabled={!outcome} onClick={() => void transition('closed')}>Close job</button>
      </div>}
      {!targets.length && <p>No status changes are available.</p>}
    </fieldset>
  </section>;
}
