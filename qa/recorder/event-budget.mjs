export const MAX_EVENTS = 10_000;
const MAX_PENDING_EVENT_OPERATIONS = 8;

// Admission is bounded by concurrent work, not events per wall-clock interval.
export function createEventBudget() {
  let eventCount = 0;
  let pendingInspections = 0;
  let pendingWrites = 0;
  return {
    atEventLimit: () => eventCount >= MAX_EVENTS,
    reserveInspection() {
      if (pendingInspections + pendingWrites >= MAX_PENDING_EVENT_OPERATIONS ||
          eventCount + pendingInspections >= MAX_EVENTS) return false;
      pendingInspections += 1;
      return true;
    },
    releaseInspection() { pendingInspections -= 1; },
    beginWrite() {
      eventCount += 1;
      pendingWrites += 1;
    },
    endWrite() { pendingWrites -= 1; },
  };
}
