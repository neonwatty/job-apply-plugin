'use client';
import { useEffect, useRef, useState } from 'react';
import type { AnswerClient } from './answer-model';
import { cleanupApproval, cleanupApproved, cleanupExplanation, cleanupPreview } from './answer-cleanup-model';
import type { CleanupPair, CleanupPreview } from './answer-cleanup-model';

export function AnswerCleanup({ client, revision, disabled = false, onMerged, onBusyChanged }: {
  client: AnswerClient; revision: number; disabled?: boolean; onMerged?: () => void; onBusyChanged?: (busy: boolean) => void;
}) {
  const [result, setResult] = useState<{ revision: number; client: AnswerClient; preview: CleanupPreview } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  const [success, setSuccess] = useState('');
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    onBusyChanged?.(approving);
    return () => { onBusyChanged?.(false); };
  }, [approving, onBusyChanged]);
  useEffect(() => {
    generation.current++;
    request.current?.abort();
    setResult(null);
    setLoading(false);
    setApproving(false);
    setSuccess('');
    setError('');
    return () => { generation.current++; request.current?.abort(); };
  }, [client, revision]);

  async function preview() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++generation.current;
    setResult(null);
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      const raw = await client.answerRequest('/api/answers/cleanup-preview', 'GET', undefined, controller.signal);
      if (version !== generation.current || controller.signal.aborted) return;
      setResult({ revision, client, preview: cleanupPreview(raw) });
    } catch {
      // Transport and validation errors can contain response data. Keep them out of the UI.
      if (version === generation.current && !controller.signal.aborted) setError('Unable to load the cleanup preview. Try again.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }

  async function approve(pair: CleanupPair) {
    if (disabled || loading || approving || !result || result.revision !== revision || result.client !== client) return;
    if (!window.confirm(`Keep “${pair.winnerQuestion}” and merge “${pair.duplicateQuestion}” into it? The accepted answer is retained, the duplicate is merged, and references are updated.`)) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++generation.current;
    const selected = result.preview;
    // Each attempt consumes the displayed preview, including stale or failed requests.
    setResult(null);
    setError('');
    setSuccess('');
    setApproving(true);
    try {
      const raw = await client.answerRequest('/api/answers/cleanup-approve', 'POST', cleanupApproval(selected, pair), controller.signal);
      if (version !== generation.current || controller.signal.aborted) return;
      cleanupApproved(raw);
      setSuccess('Answers merged. Preview cleanup again to check for more duplicates.');
      onMerged?.();
    } catch {
      if (version === generation.current && !controller.signal.aborted) {
        setError('Unable to confirm the merge. Refresh the cleanup preview to check the latest answers before trying again.');
      }
    } finally {
      if (version === generation.current) setApproving(false);
    }
  }

  const pairs = result?.revision === revision && result.client === client ? result.preview.pairs : null;
  return <section aria-label="Cleanup preview">
    <h2>Cleanup preview</h2>
    <p>Find possible duplicate answers. Previewing changes nothing. Review and approve each merge separately.</p>
    <button type="button" disabled={loading || approving} onClick={() => void preview()}>Preview cleanup</button>
    {loading && <p role="status">Checking for possible duplicates…</p>}
    {approving && <p role="status">Merging the selected answers…</p>}
    {success && <p role="status">{success}</p>}
    {disabled && <p>Save or discard your answer edits before approving a merge.</p>}
    {error && <p role="alert">{error}</p>}
    {pairs !== null && <>
      <p role="status">{pairs.length ? `${pairs.length} possible duplicate ${pairs.length === 1 ? 'pair' : 'pairs'}. No answers changed.` : 'No clear duplicates found.'}</p>
      <ul>{pairs.map((pair, index) => <li key={index} style={{ overflowWrap: 'anywhere' }}>
        <p><strong>Accepted answer:</strong> <span>{pair.winnerQuestion}</span></p>
        <p><strong>Possible duplicate:</strong> <span>{pair.duplicateQuestion}</span></p>
        <p>{cleanupExplanation(pair)}</p>
        <button type="button" disabled={disabled || approving || loading} onClick={() => void approve(pair)}>Approve merge</button>
      </li>)}</ul>
    </>}
  </section>;
}
