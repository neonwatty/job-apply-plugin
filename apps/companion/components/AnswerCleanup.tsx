'use client';
import { useEffect, useRef, useState } from 'react';
import type { AnswerClient } from './answer-model';
import { cleanupExplanation, cleanupPreview } from './answer-cleanup-model';
import type { CleanupPair } from './answer-cleanup-model';

export function AnswerCleanup({ client, revision }: { client: AnswerClient; revision: number }) {
  const [result, setResult] = useState<{ revision: number; client: AnswerClient; pairs: CleanupPair[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    generation.current++;
    request.current?.abort();
    setResult(null);
    setLoading(false);
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
    setLoading(true);
    try {
      const raw = await client.answerRequest('/api/answers/cleanup-preview', 'GET', undefined, controller.signal);
      if (version !== generation.current || controller.signal.aborted) return;
      setResult({ revision, client, pairs: cleanupPreview(raw) });
    } catch {
      // Transport and validation errors can contain response data. Keep them out of the UI.
      if (version === generation.current && !controller.signal.aborted) setError('Unable to load the cleanup preview. Try again.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }

  const pairs = result?.revision === revision && result.client === client ? result.pairs : null;
  return <section aria-label="Cleanup preview">
    <h2>Cleanup preview</h2>
    <p>Find possible duplicate answers. This preview changes nothing; merging and approval are not available here.</p>
    <button type="button" disabled={loading} onClick={() => void preview()}>Preview cleanup</button>
    {loading && <p role="status">Checking for possible duplicates…</p>}
    {error && <p role="alert">{error}</p>}
    {pairs !== null && <>
      <p role="status">{pairs.length ? `${pairs.length} possible duplicate ${pairs.length === 1 ? 'pair' : 'pairs'}. No answers changed.` : 'No clear duplicates found.'}</p>
      <ul>{pairs.map((pair, index) => <li key={index} style={{ overflowWrap: 'anywhere' }}>
        <p><strong>Accepted answer:</strong> <span>{pair.winnerQuestion}</span></p>
        <p><strong>Possible duplicate:</strong> <span>{pair.duplicateQuestion}</span></p>
        <p>{cleanupExplanation(pair)}</p>
      </li>)}</ul>
    </>}
  </section>;
}
