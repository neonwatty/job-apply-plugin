# Workspace HTTP inventory review

This is a source inventory, not behavioral verification. All 127 entries retain
`effects: unclassified` and every scenario remains `unverified`. HTTP method
does not establish whether the Store call can perform lazy initialization or
recovery. Node assignments name migration ownership, not accepted implementations.

## Sources and counts

| Shard | Entries | Source shape |
| --- | ---: | --- |
| http-read-surfaces.json | 17 | GET exact dictionary and literal branches |
| http-read-detail-surfaces.json | 12 | GET segment predicates and nested actions |
| http-asset-surfaces.json | 19 | GET paths from ASSETS |
| http-asset-head-surfaces.json | 19 | HEAD paths from the same ASSETS |
| http-write-surfaces.json | 3 | Generic OPTIONS, PUT and DELETE rejection |
| http-write-accounts-surfaces.json | 10 | Account mutation predicates |
| http-write-profile-surfaces.json | 4 | Profile/fact mutation predicates |
| http-write-answers-surfaces.json | 21 | Answer literals and both key aliases |
| http-write-resumes-surfaces.json | 12 | Resume/request/proposal predicates |
| http-write-jobs-surfaces.json | 10 | Job predicates and action sets |

The inventory contains 29 API GET, 38 asset GET/HEAD, 57 POST/PATCH and three
generic rejected-method entries. Each entry identifies the actual routing source;
mutation entries also bind the handler that dispatches their mixin. Static entries
bind both QueryMixin and the ASSETS dictionary. Template braces name dynamic
segments, not accepted identifier grammar. Identifier decoding remains a separate
HTTP contract in `scripts/job_apply_workspace/http.py` and the called Store code.

## Dispatch order and response boundaries

`QueryMixin.do_GET` obtains the parsed path first. `/api/` requests require API
authorization; other requests pass Host validation and static lookup. HEAD passes
Host validation and static lookup only: there are no successful API HEAD routes
in this inventory, including the resume-content route.

Within `_get_api`, boot is handled before the degraded-Store guard. Next comes
the exact dictionary, followed by literal branches in source order, then detail
routing. Fixed paths therefore precede matching dynamic templates; for example
`/api/resumes/trash` is the trash listing rather than resume ID `trash`.

Detail order is trusted-fill, employer-accounts, fact-groups, encoded answers,
job pending-answer detail, legacy answers, resume detail, resume content, proposal
detail, job detail, then job activity/preflight. Both answer encodings are real
surfaces: `/api/answers/{legacyKey}` and `/api/answers/by-key/{encodedKey}`.
The pending-answer route contains two dynamic segments. Unknown detail routes
fall through to the common not-found response.

POST/PATCH first perform path/authentication/degraded-Store checks, then decode
the body, then dispatch accounts, profile, answers, resumes and jobs in that order.
Resume import and resume replace/adopt use the upload-body reader; other mutations
use the JSON-body reader. Body rejection can precede route-not-found behavior.

Answers process five literal POST routes before dynamic aliases. Each alias has
PATCH plus reveal, merge, accept, decline, trash, restore and delete POST actions.
Reveal and merge precede revision validation; other actions pass revision/body
checks before lifecycle lookup. An unknown action can therefore return a body
error before route-not-found. It is not a fabricated successful route.

The `*` OPTIONS/PUT/DELETE records identify rejection behavior only. Valid Host
OPTIONS produces method_rejected with the cross-origin-preflight message; PUT
and DELETE produce method_rejected with the method-not-allowed message. These
are not wildcard successful routes. Other unimplemented methods retain the
base HTTP handler behavior and require negative tests rather than invented
application-route entries.

## Required follow-up evidence

The checker must reconcile source changes against these reviewed entries. Literal
path matching alone cannot recover nested segment predicates, delegated answer
actions, action dictionaries or static assets. Source digest binding detects
drift but does not by itself prove this enumeration complete.

Behavioral suites still need fixed-vs-dynamic precedence, both answer encodings,
invalid/extra segments, percent decoding, query/path rejection, unknown actions,
Host/Origin/Bearer failures, degraded boot, body/upload limits, unsupported methods
and exact response envelopes. Conflict, concurrency, recovery, privacy and native
platform cells remain open. No live Store, server or browser was used for this
inventory, and no entry is promoted to a passed scenario by source inspection.
