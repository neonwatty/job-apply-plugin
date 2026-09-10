import { useEffect, useRef, useState } from 'react';
import { type Client } from './client';
import { job as decodeJob, object, type Job } from './contracts';

type Claim = { claimId: string; jobId: string; ownerLabel: string; expiresAt: string; expired: boolean };
function claimValue(value: unknown): Claim | null {
    if (value === null) return null;
    if (!object(value) || !['claimId', 'jobId', 'ownerLabel', 'expiresAt'].every(key => typeof value[key] === 'string')
        || typeof value.expired !== 'boolean') throw Error('Invalid claim status');
    return { claimId: String(value.claimId), jobId: String(value.jobId), ownerLabel: String(value.ownerLabel),
        expiresAt: String(value.expiresAt), expired: value.expired };
}

export function Claims({ client, jobs, disabled, changed, activityChanged, navigationChanged }: {
    client: Client; jobs: Job[]; disabled: boolean; changed: () => void;
    activityChanged: (active: boolean) => void; navigationChanged: (dirty: boolean) => void;
}) {
    const [claim, setClaim] = useState<Claim | null>(null);
    const [selected, setSelected] = useState<Job | null>(null);
    const [owner, setOwner] = useState('Companion owner');
    const [busy, setBusy] = useState(false);
    const [writing, setWriting] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [owned, setOwned] = useState(false);
    const [heartbeatSeconds, setHeartbeatSeconds] = useState(60);
    const credential = useRef<{ token: string; job: Job; claimId: string } | null>(null);
    const alive = useRef(false);
    const pending = useRef<AbortController | null>(null);
    async function request(path: string, body: unknown, signal: AbortSignal) {
        const raw = await client.extractionRequest('/api/claims' + path, body === undefined ? 'GET' : 'POST',
            body === undefined ? undefined : JSON.stringify(body), signal);
        const value: unknown = JSON.parse(raw);
        if (!object(value)) throw Error('Invalid claim response');
        return value;
    }
    function acceptStatus(next: Claim | null) {
        setClaim(next);
        if (credential.current && (!next || next.claimId !== credential.current.claimId || next.jobId !== credential.current.job.id)) {
            credential.current = null;
            setOwned(false);
        }
    }
    async function refresh() {
        if (pending.current) return;
        const controller = new AbortController(); pending.current = controller; setBusy(true);
        try {
            const value = await request('', undefined, controller.signal);
            if (!alive.current || controller.signal.aborted) return;
            acceptStatus(claimValue(value.claim));
            if (typeof value.heartbeatSeconds === 'number' && value.heartbeatSeconds >= 1)
                setHeartbeatSeconds(value.heartbeatSeconds);
            setLoaded(true); setError('');
        } catch {
            if (alive.current && !controller.signal.aborted) setError('Unable to refresh active application status. Try again.');
        } finally {
            if (pending.current === controller) {
                pending.current = null;
                if (alive.current) setBusy(false);
            }
        }
    }
    useEffect(() => {
        alive.current = true; void refresh();
        return () => { alive.current = false; pending.current?.abort(); pending.current = null; credential.current = null; };
    }, [client]);
    useEffect(() => { activityChanged(owned || busy); return () => activityChanged(false); }, [owned, busy, activityChanged]);
    useEffect(() => { navigationChanged(owned || writing); return () => navigationChanged(false); }, [owned, writing, navigationChanged]);
    async function action(kind: 'select' | 'acquire' | 'review-restart' | 'recover' | 'heartbeat' | 'handoff') {
        if (pending.current) return;
        const held = credential.current;
        const current = kind === 'heartbeat' || kind === 'handoff' ? held?.job : selected;
        if (!current && kind !== 'recover') return;
        if (kind === 'select' && !confirm(`Select ${String(current!.role || current!.id)} for application work at revision ${current!.revision}?`)) return;
        if (kind === 'review-restart' && !confirm(`Confirm you have not submitted this application. Restart ${String(current!.role || current!.id)} at revision ${current!.revision} for another review? Final submission remains yours.`)) return;
        const controller = new AbortController(); pending.current = controller; setBusy(true); setWriting(true); setError(''); setNotice('');
        try {
            const body = kind === 'select' ? { jobId: current!.id, expectedRevision: current!.revision, ownerConfirmed: true }
                : kind === 'acquire' ? { jobId: current!.id, expectedRevision: current!.revision, ownerLabel: owner }
                : kind === 'review-restart' ? { jobId: current!.id, expectedRevision: current!.revision, ownerLabel: owner, ownerConfirmedNotSubmitted: true }
                : kind === 'recover' ? { jobId: claim!.jobId, ownerLabel: owner }
                : kind === 'heartbeat' ? { jobId: current!.id, token: held!.token }
                : { jobId: current!.id, token: held!.token, expectedRevision: current!.revision, status: 'needs_info',
                    session: { status: 'active', attemptRevision: current!.revision,
                        blockers: [{ type: 'information', code: 'owner-input-required' }] } };
            const value = await request('/' + kind, body, controller.signal);
            if (!alive.current || controller.signal.aborted) return;
            if (kind === 'acquire' || kind === 'recover' || kind === 'review-restart') {
                const nextClaim = claimValue(value.claim), nextJob = decodeJob(value.job);
                if (!nextClaim || typeof value.token !== 'string' || !value.token) throw Error('Invalid acquisition');
                credential.current = { token: value.token, job: nextJob, claimId: nextClaim.claimId };
                setClaim(nextClaim); setOwned(true); setSelected(nextJob);
                setNotice('Application work acquired. You can return it for owner input below.');
            } else if (kind === 'select') {
                // Select returns a public job summary. Load the full canonical record before acquisition.
                const nextJob = await client.job(current!.id, controller.signal);
                if (!alive.current || controller.signal.aborted) return;
                setSelected(nextJob);
                setNotice('Job selected. Acquisition checks readiness again.');
            } else if (kind === 'heartbeat') {
                acceptStatus(claimValue(value.claim));
            } else {
                credential.current = null; setOwned(false); setClaim(null); setSelected(null);
                setNotice('Application returned for owner input.');
            }
            if (kind !== 'heartbeat') changed();
        } catch {
            if (alive.current && !controller.signal.aborted) setError('Action was not confirmed. Refresh status and the selected job before retrying; your job draft is preserved.');
        } finally {
            if (pending.current === controller) {
                pending.current = null;
                if (alive.current) { setBusy(false); setWriting(false); }
            }
        }
    }
    useEffect(() => {
        if (!owned || claim?.expired) return;
        const timer = setInterval(() => { void action('heartbeat'); }, heartbeatSeconds * 1000);
        return () => clearInterval(timer);
    }, [owned, heartbeatSeconds, client, claim?.expired]);
    async function choose(id: string) {
        if (pending.current) return;
        setSelected(jobs.find(item => item.id === id) ?? null); setError(''); setNotice('');
    }
    const blocked = disabled || busy || !loaded;
    return <section aria-label="Active application">
        <h2>Active application</h2>
        <p>Only one application can be claimed at a time. Final submission remains yours.</p>
        <button disabled={busy} onClick={() => void refresh()}>Refresh application status</button>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {loaded && !claim && <p>No active application claim.</p>}
        {claim && <p>Claimed job: {claim.jobId}. Owner: {claim.ownerLabel}. {claim.expired ? 'Expired' : 'Lease expires'}: {claim.expiresAt}.</p>}
        {claim && !owned && !claim.expired && <p>This view does not hold the claim credential. After reload or navigation, wait for expiry, refresh status, and explicitly recover the same job.</p>}
        {owned && <p>This view renews the claim automatically. Keep it open until you hand off; leaving loses its credential.</p>}
        <label>Claim owner label<input value={owner} onChange={event => setOwner(event.target.value)} disabled={busy || owned} /></label>
        {!claim && <>
            <label>Job for application work<select aria-label="Job for application work" style={{ maxWidth: '100%' }} value={selected?.id ?? ''} disabled={blocked} onChange={event => void choose(event.target.value)}>
                <option value="">Choose a job…</option>
                {jobs.map(item => <option key={item.id} value={item.id}>{String(item.role || item.url)} · {item.status} · revision {item.revision}</option>)}
            </select></label>
            {selected && <p>Selected revision {selected.revision}. Refresh the jobs list and choose again after a conflict.</p>}
            <button disabled={blocked || !selected} onClick={() => void action('select')}>Select this job</button>{' '}
            <button disabled={blocked || selected?.status !== 'ready' || !owner.trim()} onClick={() => void action('acquire')}>Acquire application work</button>
            {selected?.status === 'awaiting_review' && <button disabled={blocked || !owner.trim()} onClick={() => void action('review-restart')}>Restart reviewed application</button>}
        </>}
        {claim?.expired && <button disabled={blocked || !owner.trim()} onClick={() => void action('recover')}>Recover expired application</button>}
        {owned && !claim?.expired && <button disabled={blocked} onClick={() => void action('handoff')}>Return for owner input</button>}
    </section>;
}
