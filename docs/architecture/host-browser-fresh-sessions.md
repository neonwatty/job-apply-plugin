# Fresh host-browser session evidence

This is a reproducible protocol and a bounded evidence-index validator for the
[installed fictional fixture](host-browser-acceptance.md). Unit tests and HTTP
simulation validate the harness. They do not establish native host execution,
independent model conversations, recovery success, or human UX quality.

`gradeFreshSessionEvidence({ candidateRevision, trials })` is exported by
`evals/workflows/host-browser-session-evidence.mjs`. It performs no file reads,
browser operations, model launches, or approval actions. Its `passed` result
means that the supplied evidence index satisfies the structural and fixture
checks. It always returns:

- `evidenceKind: "fresh_session_evidence_index"`
- `actualHostAcceptance: "requires_external_trace_review"`
- `independentModelConversations: false`
- `humanUxMetrics: null`

A separate reviewer must open the referenced artifacts to establish provenance.
A trace path, session ID, or `no_history` label alone proves nothing about the
execution environment. Do not relabel this function's result as host acceptance.

## Receipt contract

The top-level object has exactly `candidateRevision` (a full lowercase 40-digit
Git SHA) and `trials` (1–100 entries). The JSON encoding is limited to 2 MB.
Each trial has exactly these fields:

| Field | Content |
| --- | --- |
| `trialId` | Unique retained ledger ID |
| `scenario` | `controls-handoff`, `uncertain-resume`, or `stale-report` |
| `status` | `completed`, `failed`, or `unstarted` |
| `candidateRevision` | Exact top-level candidate SHA |
| `session` | `{ sessionId, launchTraceRef, contextIsolation, parentSessionId }` |
| `hostBrowser` | `{ toolName, traceRef, sessionId }` |
| `fixture` | `{ manifestRef, gradeRef, before, after }` |
| `timeline` | Ordered events described below |

Session `contextIsolation` must be `no_history`; the session must differ from
its coordinator's `parentSessionId`. The host session ID must match the trial's.
Session IDs, launch references, host transcript references, manifest references,
and grade references must be unique across trials. Use a separate exported host
transcript for each session. All nonempty strings are bounded to 2,048 characters.
The nested objects above are closed: unknown fields fail validation. Fixture
`before` and `after` are the fixture's independently captured snapshots, including
the final private command receipts; they retain their existing fixture shape.
Capture `before` at the fresh-agent handoff boundary, after any coordinator seed
edits. Its page events and command receipts must be exact prefixes of their final
sequences. Retain the actual boundary snapshot, including its receipt history.

Each timeline item is exactly `{ kind, traceRef, receiptIndex }`, with at most
1,000 items per trial. `traceRef` locates the exact event in the retained host or
coordinator transcript and must be unique within the trial. Kinds are:

- `canonical_context`: `receiptIndex` is the zero-based index into
  `fixture.after.receipts` of a successful `host-browser-context` command.
- `browser_observation`: native host DOM observation; `receiptIndex: null`.
- `browser_action`: one or more explicitly traceable page edits;
  `receiptIndex: null`. Include every edit, or use a trace locator covering the
  complete consecutive edit batch. Context and observation must precede edits.
- `report`: `receiptIndex` identifies a successful agent-attested report receipt;
  context and observation must precede it. A subsequent action/report requires
  another context read because persistence may advance the revision.
- `recovery`: interruption/recovery boundary; `receiptIndex: null`. Both canonical
  context and DOM observation must be reread afterward before actions/reports.

Receipt indices must advance strictly and start at or after
`fixture.before.receipts.length`; historical context/report receipts cannot
establish fresh-session activity. Fresh appended context and report receipts
are required even when no new field edits are needed. The validator checks actual command and
result shapes at those indices. External trace review must verify that the
index includes all actions/reports, accurately orders observations, and matches
the real candidate/session. It must also confirm that recovery uses a new read,
not a copied prior response. This protocol gives no new browser authority.

An unstarted trial retains its ID, scenario and candidate with `session`,
`hostBrowser`, and `fixture` set to null and `timeline: []`. A failed trial retains
whatever evidence exists; incomplete evidence fails validation. All valid status
labels remain in completed/failed/unstarted denominators, and neither failed nor
unstarted entries can pass. Never remove failed attempts from the ledger.

The validator recomputes `gradeHostBrowser(before, after, scenario)` rather than
accepting a claimed passing grade. Its `pageCounts` reports input events, change
events, prevented submit attempts, observer rejections, and `redundantInput`.
Counts are deltas since the retained `before` snapshot. The latter counts fresh
input events beyond the first input event per control (including seed history); it is
an event metric, not a judgment that typing or an edit was unnecessary.
Reconstruction after page loss can legitimately repeat earlier field writes.
A fresh agent may observe and report already completed seed edits with zero new
page writes; the validator does not require repeating them. Human
question counts and UX scores remain null until a person reviews the transcript.

## Serial trial procedure

1. Record the exact committed candidate SHA and planned trial matrix in a private
   ledger, including unstarted slots. Use the three scenarios above and disclose
   missing scenario coverage; a passing subset cannot establish full coverage.
2. Start a new installed fixture directory for one slot using the acceptance CLI.
   Retain its manifest and initial observer snapshot. Check its candidate SHA
   against the ledger. Keep its administrative token private.
3. Launch one genuinely fresh agent session without inherited conversation history
   (`fork_turns: "none"` for a supported subagent launcher). Retain the actual
   launch response/trace showing session identity, coordinator identity, and
   context isolation. Give the agent only the candidate, fixture instructions,
   installed skill paths and this scenario's task. Do not supply prior trial
   solutions. Changing a session label inside the same conversation does not
   create a fresh session.
4. Run one browser trial at a time on its newly created controlled fixture tab.
   The fresh agent must use the exposed native host browser tools, observe the
   DOM, and read canonical `host-browser-context` before edits/reporting. Use
   the existing acquisition/report protocol and exact canonical revisions.
   Never use the owner's tabs/Store, a live ATS, HTTP event simulation, or Submit.
5. For `uncertain-resume`, retain interruption and reobservation checkpoints plus
   the intervening context and DOM rereads. This scenario is an interruption
   checkpoint, not proof of a browser/process crash. For `stale-report`, retain
   actual stale rejection and exact replay receipts plus page counters. Follow
   the acceptance document for exact commands and final Needs Info handoff.
6. Independently inspect and grade the fixture, retaining every grade attempt,
   initial/final snapshots, command receipts and full host transcript. Close
   the owned fixture with the CLI and retain shutdown evidence before starting
   the next trial. Never run browser trials in parallel.
7. Populate the receipt contract, then call the exported validator from Node.
   Retain its full output alongside the ledger. This supplies a reproducible
   structural check, independent fixture-grade recomputation and denominators.
8. Review launch/host traces externally. Verify exact candidate and installed
   fixture identity, absence of inherited conversation history, native host-tool
   calls and session ownership, context/DOM ordering, page effects, and preserved
   failed attempts. Record the review separately with reviewer identity and
   artifact references. Only that reviewed evidence supports a claim of actual
   fresh host-agent trials. Score human UX separately if requested.

No production schema changes, trusted-adapter evidence, human approval, final
submission, or host support expansion follows from this harness. Full release
packaging remains a separate gate.
