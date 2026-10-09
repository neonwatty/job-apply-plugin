export const modelTurnTimeout = 360_000;
export const baselineIdleMilliseconds = 900_000;

// The idle timer starts before fixture observations and prompts. Reserve the whole model
// deadline plus process termination margin, or fail before starting a timed conversation.
export function requireAcquisitionWindow(startedAt, now = Date.now()) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || now < startedAt
    || now + modelTurnTimeout + 10_000 >= startedAt + baselineIdleMilliseconds) {
    throw Error('Owned baseline broker has insufficient acquisition lifetime');
  }
}
