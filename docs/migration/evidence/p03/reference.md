# P03 local testing reference

This reference captures the existing local test selection and Git snapshot behavior for the reviewed affected-test mappings work. Matrix registrations are executable inputs to selection. Staged merge snapshots must retain actual ancestry to validate evidence from integrated branches.

The three frozen cells contain 27 explicit witnesses: 12 Git snapshot/push checks, eight local policy checks and seven affected-selection checks. The Git witnesses include real two-parent and octopus merges, malformed merge metadata, and preservation of the owner's HEAD, index, status and MERGE_HEAD. The remaining cells cover existing focused seams, conservative escalation, rename/deletion routing, matrix inventory checks, required results and exact-identity receipt reuse.

All cells run on the frozen node-local environment against synthetic owned fixtures. Raw TAP must match every frozen literal test name with no failures, cancellations, skips or TODO results. Each cell has a 180-second timeout and 1 MiB output budget. The exact subject, inputs, source bytes and raw logs are bound by independently reviewed receipts.

The reference owns the six selection/snapshot modules, three tests, matrix and evidence documents named by its audit. Imported execution helpers remain immutable inputs. Existing matrix bytes must be preserved during integration; this scope does not authorize unrelated registration changes.

P03.R acceptance establishes these bounded baseline observations. P03.I and P03.V remain open: every accepted seam still needs its complete transitive consumer mapping and mutation evidence that no consumer silently disappears. Passing the current focused rules is not proof that their consumer coverage is complete. No product, native-host, release or final migration acceptance is granted.
