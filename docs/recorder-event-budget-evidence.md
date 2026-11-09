# Recorder event budget regression

PR 49 run `33982907385` rejected 66 recorded events against a test-only ceiling
of 64. The recorder has no 64-event contract: it limits pending inspections plus
writes to eight and total recorded events to 10,000. The browser scenario sends
200 clicks through sequentially awaited CDP calls. Work can drain between those
calls, so cumulative accepted events are not a measure of queue saturation.

The existing accounting is extracted unchanged into `qa/recorder/event-budget.mjs`.
Deterministic tests hold its slots without relying on browser or disk timing:

- 200 inspection attempts admit exactly eight; releasing a rejected inspection
  restores exactly one slot.
- Pending writes and inspections share the same eight-slot budget; completing
  one write restores exactly one slot.
- Sequential completed work can exceed 64 events. Outstanding inspections
  reserve the remaining session capacity, and admission stops at 10,000.

The browser scenario retains its 200 trusted clicks and privacy assertions,
but checks the actual session cap rather than an incidental throughput count.
No production limit, deadline, retry, sensitivity check, or write ordering changes.
The deterministic tests exercise the same budget used by the recorder; they do
not simulate browser event delivery or establish a processing-speed guarantee.
