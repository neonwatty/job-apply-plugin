# UI infrastructure reference

Append seven original-only cases to the existing workspace helper test entry
point, using separately owned test support. Cover API errors, auth storage,
request options and signals, stale responses, callback errors, complete state
shape, DOM lookup and timers, and FileReader events and failures.

Preserve all existing callbacks and approved request-builder behavior. Fixtures
use synthetic browser globals and owned state; no owner browser or Store is used.
The TypeScript port must preserve the original global-access timing and must not
invent cancellation behavior. Bootstrap and app routing remain separate work.
