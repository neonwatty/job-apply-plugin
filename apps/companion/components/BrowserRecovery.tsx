'use client';
import type { Client } from './client';
import { browserRecoveryProjection, type BrowserRecoveryProjection } from './browser-recovery-model';
import { useProjection } from './projection-view';

type RecoveryViewProps = {
  data: BrowserRecoveryProjection | null;
  loading: boolean;
  error: string;
  refresh(): void;
};

export function BrowserRecoveryView({ data, loading, error, refresh }: RecoveryViewProps) {
  // A previous ready snapshot must not imply current readiness while a refresh is pending or failed.
  const guidance = !loading && !error && data?.available ? data.guidance : null;
  return <section className="browser-recovery-panel" aria-labelledby="browser-recovery-heading">
    <div className="workspace-panel-heading">
      <div><p className="eyebrow">Browser recovery</p><h3 id="browser-recovery-heading">Saved browser actions</h3></div>
      <button className="secondary" type="button" onClick={refresh} disabled={loading}>Refresh browser status</button>
    </div>
    {loading && <p className="workspace-status" role="status">Checking saved browser actions…</p>}
    {!loading && error && <p className="error" role="alert">Browser recovery status could not be verified. Refresh to check again. Keep your browser draft open; do not repeat an uncertain action.</p>}
    {!loading && !error && (!data || !data.available) && <p className="workspace-status" role="status">Browser recovery status is unavailable for this workspace. Keep your browser draft open and review it manually before continuing.</p>}
    {guidance && <>
      {guidance.status === 'ready' && <p className="notice" role="status">No unresolved browser actions are recorded. This saved status does not confirm that a browser is connected or an action is approved.</p>}
      {guidance.status === 'reconciliation_required' && <>
        <p className="notice" role="status"><strong>An earlier browser action has an uncertain outcome.</strong> Further automated changes are blocked across this workspace.</p>
        <ol>
          <li>Keep the existing browser draft open. Do not repeat the action or clear the saved history.</li>
          <li>Ask the application agent to check the existing result. Read-only reconciliation requires an active protected browser host with current access to this attempt.</li>
          <li>If that host is unavailable or the result cannot be verified, stop automation and take over manually. Review the existing form before changing it.</li>
        </ol>
      </>}
      {guidance.status === 'capacity_reached' && <>
        <p className="notice" role="status"><strong>Saved browser action history is full.</strong> Further automated changes are blocked.</p>
        <p>Stop automation, preserve the browser draft, and finish by manual handoff. Do not delete saved history or retry the write to make room.</p>
      </>}
      <dl className="account-readiness" aria-label="Saved browser action counts">
        <div><dt>Recent actions</dt><dd>{guidance.hotOperationCount}</dd></div>
        <div><dt>Archived actions</dt><dd>{guidance.archivedOperationCount}</dd></div>
        <div><dt>Archive batches remaining</dt><dd>{guidance.archiveSegmentsRemaining}</dd></div>
      </dl>
      <p>Archived actions retain their recorded outcomes. Remaining archive batches are storage capacity, not permission to act.</p>
    </>}
    <p>For an application draft, continue in its original chat. Saved status cannot confirm that another chat can access the same tab. If the tab is unavailable, preserve the checkpoint and request a fresh attempt explicitly; do not reopen the application link automatically.</p>
    <p className="automation-safety">Refreshing only reads saved status. Review and submit the application yourself on the employer site.</p>
  </section>;
}

export function BrowserRecovery({ client, refreshKey = 0 }: { client: Client; refreshKey?: number }) {
  const projection = useProjection(client, '/api/browser-recovery', browserRecoveryProjection, refreshKey);
  return <BrowserRecoveryView {...projection} />;
}
