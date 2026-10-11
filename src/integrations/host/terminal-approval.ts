import { createInterface } from 'node:readline/promises';
import type { ReadStream, WriteStream } from 'node:tty';
import { TaskProtocolError } from '../../contracts/workspace/workflow-tasks.js';
import type { OperatorApprovalSession } from './approval-session.js';

/** Dedicated operator TTY, never the model's stdin/stdout. TTY presence does not
 * authenticate a human; the embedding must separately exclude model access.
 */
export function createTerminalApprovalSurface(session: OperatorApprovalSession,
  input: ReadStream, output: WriteStream) {
  if (!input.isTTY || !output.isTTY || input.destroyed || output.destroyed) {
    throw new TaskProtocolError('broker_unavailable');
  }
  const terminal = createInterface({ input, output, terminal: true, historySize: 0 });
  let busy = false, closed = false;
  let active: AbortController | undefined;
  const close = () => {
    closed = true; active?.abort(); session.close(); terminal.close();
  };
  terminal.on('close', () => { closed = true; active?.abort(); session.close(); });
  return Object.freeze({
    async review(raw: unknown, lifetimeMilliseconds = 60_000) {
      if (busy || closed) throw new TaskProtocolError('broker_unavailable');
      busy = true;
      let challengeId: string | undefined;
      let approved = false;
      const abort = new AbortController(); active = abort;
      const timer = setTimeout(() => abort.abort(), lifetimeMilliseconds);
      try {
        const challenge = await session.challenge(raw, lifetimeMilliseconds);
        challengeId = challenge.challengeId;
        if (closed || abort.signal.aborted) throw new TaskProtocolError('user_event_required');
        // JSON escaping prevents event strings from injecting terminal control sequences.
        output.write(`\nReview exact workflow event (approval is not final submission):\n${JSON.stringify(challenge.review, null, 2).replace(/[\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`);
        const reply = await terminal.question(
          `Type approve ${challengeId} or deny ${challengeId} (expires within at most ${lifetimeMilliseconds} ms): `,
          { signal: abort.signal });
        if (reply === `approve ${challengeId}`) {
          const result = await session.decide(challengeId, 'approve'); approved = true; return result;
        }
        if (reply === `deny ${challengeId}`) return await session.decide(challengeId, 'deny');
        throw new TaskProtocolError('user_event_required');
      } finally {
        clearTimeout(timer); active = undefined; busy = false;
        // Invalid/expired input closes only the challenge, not any prior grant.
        if (challengeId && !approved) session.revoke(challengeId);
      }
    },
    close,
  });
}
