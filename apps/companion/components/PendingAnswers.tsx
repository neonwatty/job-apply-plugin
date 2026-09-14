'use client';
import { useEffect, useRef, useState } from 'react';
import type { AnswerClient } from './answer-model';
import { pendingAnswerResolution, pendingAnswerResolved, pendingAnswers } from './pending-answer-model';
import type { PendingJob, PendingQuestion } from './pending-answer-model';

export function PendingAnswers({ client, revision, disabled, onBusyChanged, onResolved, onOpenAnswer }: {
  client: AnswerClient; revision: number; disabled: boolean; onBusyChanged?: (busy: boolean) => void;
  onResolved: () => void; onOpenAnswer: (key: string) => void;
}) {
  const [result, setResult] = useState<{ client: AnswerClient; revision: number; jobs: PendingJob[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const mutationActive = useRef(false);
  useEffect(() => {
    onBusyChanged?.(resolving);
    return () => onBusyChanged?.(false);
  }, [resolving, onBusyChanged]);
  useEffect(() => {
    generation.current++;
    request.current?.abort();
    mutationActive.current = false;
    setResult(null);
    setLoading(false);
    setResolving(false);
    setError('');
    return () => { generation.current++; request.current?.abort(); };
  }, [client, revision]);

  async function refresh() {
    if (mutationActive.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++generation.current;
    setResult(null);
    setError('');
    setLoading(true);
    try {
      const raw = await client.answerRequest('/api/pending-answers', 'GET', undefined, controller.signal);
      if (version !== generation.current || controller.signal.aborted) return;
      setResult({ client, revision, jobs: pendingAnswers(raw) });
    } catch {
      if (version === generation.current && !controller.signal.aborted) setError('Unable to load pending questions. Refresh to try again.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }
  async function resolve(job: PendingJob, field: PendingQuestion) {
    if (disabled || loading || mutationActive.current || !field.resolutionEligible || !result || result.client !== client || result.revision !== revision) return;
    if (!window.confirm(`Recheck the saved answer for “${field.question || 'Information requested'}” and resolve this question if it is still eligible?`)) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const version = ++generation.current;
    mutationActive.current = true;
    onBusyChanged?.(true);
    setResolving(true);
    // Consume the snapshot on every attempt; a failed response may still have committed.
    setResult(null);
    setError('');
    try {
      const raw = await client.answerRequest(`/api/jobs/${encodeURIComponent(job.id)}/resolve-pending-answer`, 'POST', pendingAnswerResolution(job, field), controller.signal);
      if (version !== generation.current || controller.signal.aborted) return;
      pendingAnswerResolved(raw);
      onResolved();
    } catch {
      // Neither server errors nor response bodies may expose saved answer values.
      if (version === generation.current && !controller.signal.aborted) setError('Unable to confirm resolution. Refresh pending questions to check the latest state before trying again.');
    } finally {
      if (version === generation.current) {
        mutationActive.current = false;
        setResolving(false);
        onBusyChanged?.(false);
      }
    }
  }
  const jobs = result?.client === client && result.revision === revision ? result.jobs : null;
  return <section className="answer-support-panel" aria-label="Pending questions">
    <div className="answer-support-heading"><div><p className="eyebrow">Application inbox</p><h2>Pending questions</h2></div><button className="secondary" type="button" disabled={loading || resolving} onClick={() => void refresh()}>Refresh pending questions</button></div>
    <p>Recheck saved answers for applications waiting for information. Each resolution needs your confirmation.</p>
    <p>Sensitive questions need separate confirmation and cannot be handled by this recheck.</p>
    {loading && <p role="status">Loading pending questions…</p>}
    {resolving && <p role="status">Rechecking the saved answer…</p>}
    {disabled && <p>Save or discard your answer edits before resolving a question.</p>}
    {error && <p role="alert">{error}</p>}
    {jobs !== null && <>
      {!jobs.some(job => job.pendingInformation.length > 0) && <p role="status">No pending questions found.</p>}
      <ul className="answer-support-list">{jobs.map(job => <li key={job.id}>
        <h3>{job.role} · {job.company}</h3>
        <ul className="pending-question-list">{job.pendingInformation.map((field, index) => <li key={`${field.reference}-${index}`}>
          <p>{field.question || 'Information requested'}</p>
          {!field.resolutionEligible && <p>This question needs further review before it can be resolved.</p>}
          <div className="button-row">{field.answerKey && <button className="secondary" type="button" disabled={disabled || resolving} onClick={() => onOpenAnswer(field.answerKey!)}>Open saved answer</button>}
          <button className="secondary" type="button" disabled={disabled || resolving || !field.resolutionEligible} onClick={() => void resolve(job, field)}>Resolve question</button></div>
        </li>)}</ul>
      </li>)}</ul>
    </>}
  </section>;
}
