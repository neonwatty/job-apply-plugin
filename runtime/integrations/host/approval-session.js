import { randomUUID } from 'node:crypto';
import { TaskProtocolError } from '../../contracts/workspace/workflow-tasks.js';
import { snapshot } from '../../harness/validation.js';
const deny = () => { throw new TaskProtocolError('user_event_required'); };
/** Private embedding port. The deployment declaration is trusted host configuration,
 * not runtime attestation, and must never be populated from a model proposal.
 */
export function createOperatorApprovalSession(host, deployment, now = () => performance.now()) {
    if (deployment?.modelTransport !== 'json_proposals_only'
        || deployment?.operatorChannel !== 'host_private_terminal') {
        throw new TaskProtocolError('broker_unavailable');
    }
    let closed = false, lastTime = -Infinity, generation = 0;
    let pending;
    const issued = new Map();
    const close = () => {
        closed = true;
        generation++;
        pending = undefined;
        for (const value of issued.values())
            host.approvals.revoke(value.grant);
        issued.clear();
    };
    const clock = () => {
        const at = now();
        if (closed || !Number.isFinite(at) || at < lastTime) {
            close();
            return deny();
        }
        lastTime = at;
        if (pending && pending.expiresAt <= at)
            pending = undefined;
        for (const [id, value] of issued)
            if (value.expiresAt <= at) {
                host.approvals.revoke(value.grant);
                issued.delete(id);
            }
        return at;
    };
    return Object.freeze({
        async challenge(raw, lifetimeMilliseconds = 60_000) {
            const at = clock();
            if (pending || !Number.isSafeInteger(lifetimeMilliseconds) || lifetimeMilliseconds < 1
                || lifetimeMilliseconds > 300_000 || issued.size >= 64)
                return deny();
            const epoch = ++generation;
            const review = snapshot(await host.review(snapshot(raw)));
            clock();
            if (epoch !== generation || at + lifetimeMilliseconds <= lastTime)
                return deny();
            pending = Object.freeze({ challengeId: randomUUID(), review, expiresAt: at + lifetimeMilliseconds });
            return pending;
        },
        async decide(challengeId, decision) {
            clock();
            const value = pending;
            if (!value || value.challengeId !== challengeId || !['approve', 'deny'].includes(decision))
                return deny();
            pending = undefined; // A challenge is consumed before any asynchronous re-review.
            const epoch = ++generation;
            if (decision === 'deny')
                return Object.freeze({ status: 'denied', challengeId });
            const fresh = await host.review(value.review.event);
            const remaining = Math.floor(value.expiresAt - clock());
            if (epoch !== generation || remaining < 1
                || fresh.binding.eventFingerprint !== value.review.binding.eventFingerprint
                || fresh.binding.inputRevision !== value.review.binding.inputRevision)
                return deny();
            const grant = host.approvals.approve(value.review.binding, remaining);
            issued.set(challengeId, { grant, expiresAt: value.expiresAt });
            return Object.freeze({ status: 'approved', challengeId, expiresAt: value.expiresAt });
        },
        revoke(challengeId) {
            generation++;
            if (pending?.challengeId === challengeId)
                pending = undefined;
            const value = issued.get(challengeId);
            if (value) {
                host.approvals.revoke(value.grant);
                issued.delete(challengeId);
            }
        },
        close,
    });
}
