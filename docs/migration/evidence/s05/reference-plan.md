# S05 reference preparation at the registered checkpoint

Draft for independent review; no reference acceptance is claimed.

Actual registration checkpoint: 2da2e1f52709c967915318a661b09339d2d3e49a. The effective 346-assignment DAG is
`docs/migration/evidence/p03/retry2/approved-dag.json`. All five reference commands
are registered. The original 32 source pins and complete 17-module Python union
were verified against this checkpoint. Historical draft SHA placeholders below
are superseded only by this concrete checkpoint and the eventual immutable
manifest base; original behavior and required observations remain unchanged.

Assigned implementation author and file owner: `timestamp_tests`. Independent
reviewer: `hooks_audit`. The coordinator alone writes preparation metadata.
Reference assignments retain their original `P00.V` dependency. They do not
accept product implementation or satisfy native launch gates.

All exact test names, budgets, allowed files and baseline obligations from the
reviewed v2 audit are retained. Freeze the plan and audit before the reference
manifest. Bind original source files, test support, package/lock/matrix and
runtime provenance. New reference helpers may load only that closed source set;
new imports require review before the exact source capture. All source/test
files remain at most 500 physical lines.

Expected-vector drafts are hand-derived review inputs, not automatically
refreshed golden output. Retain disagreements with actual CPython observations
until independently reconciled. Strip executable probe text from committed
vector data; preserve its exact source and provenance separately. Compare
complete errors and effect order, never only a category wildcard. Evidence
records actual host/interpreter details and keeps unsupported/native gaps open.

The bounded invalid-parent observations establish that Unicode error objects
contain pathlib-resolved paths. Construct expected objects and positions from
the independently resolved valid owned root plus the fixed component recipe;
never derive expectations from the caught error. Compare the complete actual
error object and fields against those independently constructed values.

# S05.R bounded reference plan v2

Status: external freeze-review plan. Independently authored vector data, pure codec/key probes and bounded three-parent probes are complete; full registered reference source/tests, cache/path capture and baseline validation remain outstanding. S05.R depends on P00.V; S05.I additionally requires S08.V and accepted S05.R. No production interfaces or matrix edits belong to this reference package.

## Goal and evidence boundaries

Freeze actual Python point filesystem encoding/decoding, managed-parent validation order and text-key cache behavior. Construct strings directly from fixed codepoint arrays; never normalize literal surrogate pairs through JavaScript strings or the TS implementation. Execute only stdlib functions and existing Python methods on owned synthetic fixtures. Keep all existing reference files/tests unchanged and bind their hashes. A returned lexical path is not a successful native filename operation, and a portable codec result is not native filesystem acceptance.

Existing references cover38 managed-path cases,16 POSIX byte-path cases,16 descriptor-digest cases and18 observation/cache cases. Their simple-string/lone-surrogate coverage does not freeze the new literal-pair versus scalar or equal-instance cache boundary. New directly named tests should invoke these immutable Python drivers and preserve their independently authored assertions; do not add nested Node wrapper layers merely to avoid generated old test names. The old tests remain independently runnable regression evidence; new direct-driver tests must not falsely claim to have executed those old Node tests.

## Exact ownership and registration prerequisites

| Proposed path | Responsibility; physical-line target |
| --- | --- |
| tools/contracts/point-paths/reference.py | Fixed48-case entry, stdlib codec probes, actual managed-path/cache method calls and provenance; <=380. |
| tools/contracts/point-paths/fixtures.py | Closed recipes/IDs/point arrays and typed cache-operation sequences; <=250. |
| tools/contracts/point-paths/support.py | Owned ASCII/valid-Unicode fixture setup, event observation, exact exceptions and unchanged-tree snapshots; <=450. |
| tests_js/point_paths_reference.test.mjs | Five new direct literal tests for48 cases/profiles/input refusal; <=480. |
| tests_js/point_paths_parent_reference.test.mjs | Four direct profile tests for old managed38 and byte16 drivers, preserved positive assertions and explicit native gaps; <=480. |
| tests_js/point_paths_digest_reference.test.mjs | Four direct profile tests for old digest16 and observation18 drivers; <=480. |
| docs/migration/evidence/s05/reference-vectors.json | Independently fixed48 input/expected outcome/effect recipes, data only. |
| docs/migration/evidence/s05/reference-baselines.json | Independently copied old expected tables/closed IDs, with source-test hashes and explicit availability obligations; data only. |
| docs/migration/evidence/s05/reference.md; reference-plan.md; reference-audit.json; S05.R.json | Scope/results, coordinator-frozen plan/audit/manifest. |

Three reference Python modules and three executable test modules; no production modules. Every source/test<=500 with no packing/minification/exception increase. Expected JSON is never evaluated or used to choose a module/executable. All three exact test paths are explicitly literal-registered at2da2e1f52709c967915318a661b09339d2d3e49a; this does not imply test execution. No unregistered JS support helpers. S04 needs point_persistence_reference.test.mjs and point_persistence_baselines.test.mjs, and all five are now present in that committed matrix checkpoint. Workers do not own the matrix.

## Closed48-case matrix

All cases are fixed; no random/fuzzer or fault Cartesian product. Bind IDs, point arrays/bytes, record shape, call sequence and injected stages independently in tests and fixtures. Unless a case says otherwise, paths are under a newly owned temporary directory with ASCII component names and fixed sentinel bytes. No native invalid-byte filename creation is required by the new48 cases; the unchanged byte driver separately records its existing capability gap.

| Group | Exact IDs and data |
| --- | --- |
| Filesystem encode (12) | encode-empty []; encode-nul [0]; encode-scalar [65536]; encode-high [55296]; encode-low [56320]; encode-low7f [56447]; encode-escape80 [56448]; encode-escapeff [56575]; encode-pair [55296,56320]; encode-high-escape [55296,56448]; encode-adjacent-escapes [56448,56575]; encode-nul-high [0,55296]. |
| Filesystem decode (12) | decode-empty emptyhex; decode-ascii-nul 610062; decode-max-scalar f48fbfbf; decode-scalar f0908080; decode-ff ff; decode-80 80; decode-overlong2 c0af; decode-overlong3 e08080; decode-surrogate-pair-bytes eda080edb080; decode-truncated4 f09080; decode-mixed 61ff62; decode-out-of-range f4908080. |
| Managed parent/record order (16) | managed-scalar-leaf; managed-pair-leaf; managed-escape-leaf; managed-nul-leaf; managed-pair-parent; managed-nul-parent; managed-nul-pair-parent; managed-outside-parent; managed-pair-inside-link; managed-pair-outside-link; managed-pair-parent-error; managed-pair-root-error; managed-missing-storage; managed-missing-file; managed-nonstring-file; managed-empty-file. |
| Actual cache sequences (8) | cache-equal-pair; cache-equal-scalar; cache-pair-versus-scalar; cache-escape-versus-scalar; cache-nul-text; cache-empty-text; cache-text-versus-numeric; cache-expired-pair. |

Managed recipes: scalar=U+10000, pair=D800 DC00, escape=DCFF. Parent cases append '/file.bin' to their named invalid component. nul-pair-parent is [0,D800,DC00] followed by '/file.bin', freezing encoding-versus-NUL precedence. outside-parent is '../outside/file.bin'. inside/outside symlinks have ASCII names and targets '.' / '../outside'; only the final leaf carries a pair. Faults are OSError at the first or second resolve call, respectively; do not combine unrelated failures. Missing storage record is {}; missing file is {storageKind:managed}; nonstring file is integer1; empty file is empty text. All other records contain the exact required managed fields. Tests bind each complete record independently.

Cache recipes use one existing ASCII-named regular file with stable stat identity and a fixed injected clock, plus the actual ResumeStorageMixin._managed_resume_observation. Every call's record id is explicitly represented as text points or typed bool/int/float. Equal-pair/equal-scalar each use two independently constructed equal strings with a two-character 'id' prefix, ensuring distinct object identity can be checked without relying on Python's empty/single-character interning. Pair-versus-scalar uses the same prefix and changes only the final pair/scalar. Escape-versus-scalar uses DCFF versus U+00FF. NUL/empty cases reuse legal dictionary text keys but never use those strings as native filenames. Text-versus-numeric sequence is text'1', integer1, float1.0, booleanTrue, independently asserting the text key stays distinct while Python numeric keys alias. Expired-pair advances the fixed clock exactly to OVERVIEW_DIGEST_CACHE_SECONDS and then through a fresh equal-text access. Do not port a new numeric dictionary or infer observation semantics from S01 alone.

## Observation and independent expected-value protocol

Codec capture calls actual os.fsencode/os.fsdecode under independently verified UTF8/surrogateescape filesystem policy. Record complete input point arrays/byte hex and successful output hex/points; errors include type/message/encoding/full object points/start/end/reason plus separate cause/context/suppression. NUL is valid at the codec boundary. A literal pair remains unencodable; U+10000 encodes; DC80–DCFF map to their original bytes; invalid byte sequences decode into exact surrogateescape points, not surrogatepass pairs. Independent tests explicitly bind these results. Do not substitute S02's UTF8 surrogatepass decoder, which has a different contract.

For managed-path cases, call the actual existing method with an observed pathlib-compatible root. Record construction/resolve arguments as codepoint arrays and the order of parent resolution then root resolution; retain actual filesystem calls when observing them without changing return values. Record original record identity/values before and after. Only the owned root prefix is relabeled '<root>'; do not normalize the remaining path points, anchors, separators or unencodable leaf into a lossy string. Successful lexical outcomes separately record whether fsencode succeeds, with its exact result/error, rather than implying that an unencoded leaf was opened.

Required positive/negative order assertions: storageKind mismatch, absent managedFile, and integer managedFile fail before resolution with their distinct StoreError, KeyError and path-join TypeError outcomes; empty managedFile joins to root and fails identity validation after parent then root resolution; a normal/pair/NUL/escape leaf validates its parent then root before returning; an outside parent produces the identity error before any final-leaf encoding; an invalid parent fails at the first observed resolution, with no root call; encoding of a high-surrogate parent takes precedence over its embedded NUL. Existing38-case driver preserves //, dot/dotdot, absolute-child, loop/readlink/missing/non-directory behavior, including3.12 versus3.13/3.14 distinctions. New point cases do not replace those regressions.

Cache capture records exact ordered path/stat/symlink/clock/digest/second-stat calls, result objects, pre/post dictionary entries as ordered typed keys, whether the retained original key object survives overwrite, and unchanged real-file snapshots. Use actual Python dictionary lookup and the existing method; no fake cache result or normalized JS-key substitute. Cache hits suppress digest/second-stat according to the real method, equal text instances share entries, pair/scalar identities do not. Mixed numeric aliases must not merge text'1'. Clock and metadata comparisons use exact microsecond/ns/integer fields, not rounded JSON numbers. Injected stable metadata/clock are labeled model controls, while actual digest reading and owned file effects are separately identified.

Expected JSON is independently authored from fixed recipes, existing source contracts and old test tables, with manual review of every deterministic value/error/call-order field. Full actual capture is retained as evidence, never used to regenerate expectations. Record nondeterministic native identities/mtime as complete observations plus exact within-capture equality relationships; do not invent literal inode values. If actual behavior contradicts an expected hypothesis, preserve the failure and review the correction before acceptance. No wildcard errors, arbitrary mismatch-to-skip, or selecting a convenient expected outcome after observing results.

## Positive provenance and bounded execution

Each of the four top-level profile tests must successfully launch its named executable; absence is failure. The three versioned aliases must actually identify distinct required CPython3.12/3.13/3.14 profiles, and the default alias may duplicate one. Independently probe resolved executable/version/implementation, OS/platform/architecture/byteorder, filesystem encoding/error policy; hash executable, Python source/loaded import closure, pathlib (including split submodules), os/posixpath, json modules and native relevant origins (_json/_codecs/posix/_io). Builtin provenance is bound to executable hash. Validate recorded paths against independent probes, not against their own echoed fields. Patch/build changes require explicit comparison/review, never alias-name-only acceptance.

New entry rejects argv and nonempty stdin with status2, empty stdout and exact ASCII point_paths_reference_input_rejected followed by exactly one LF byte (hex0a). No caller-selected paths/files/cases, environment-selected golden source, browser/network or public Store. Tests directly launch fixed new and old Python drivers; old script input-refusal behavior remains asserted without modifying those scripts. Complete raw JSON and its exact stdout SHA256 appear in TAP diagnostics before pass/fail assertions; fixed small inputs keep each new profile<=150000bytes and20seconds. Use two separate baseline cells to keep54 and34 legacy cases/profile within bounded output/time. Every cell is120seconds/1MiB, with independent child bounds; overruns require reviewed split, not truncation or silent budget expansion.

## Native unavailable facts are not accepted operations

The old POSIX byte driver has five named setup-dependent cells: resolve-byte-directory, resolve-byte-file, resolve-byte-link, managed-byte-parent, managed-byte-link-parent. The current macOS filesystem reported EILSEQ during owned invalid-byte-name setup. Eleven other cases were observed per profile, including valid Unicode, invalid-byte symlink targets and lexical unencodable final names. Preserve each unavailable record's exact stage/name/errno and the five named obligations. Only the documented EILSEQ setup limitation may be classified this way; unrelated errors fail the capture.

The new direct baseline tests validate the complete16-row record set and independently validate all supported outcomes plus exact unavailable records. Their names explicitly describe observed facts/open cells. A passing reference-record test means the observed capabilities and gaps were accurately frozen; it does not mean all16 operations succeeded, that a prior skipped profile was converted into native acceptance, or that these five product acceptance cells closed. reference.md must carry a separate open-native list, and S05.I/V cannot claim native support for it without actual separately reviewed evidence. Linux and Windows remain unobserved here. If the test filesystem supports more cases, capture those actual facts but review them before changing the frozen capability contract; do not silently treat availability as either regression or universal support.

No unnecessary parent Node wrappers: the three test files directly execute the fixed Python drivers. They port/reuse the old independently authored field assertions into self-contained test code/data, with pinned original test hashes. Raw old script observations and their original Node regression tests are distinct evidence. Normal broader regression runs may still execute the unchanged old Node suites (including their documented skips/nested tests); that cannot replace the strict new point-reference evidence.

## Exact proposed literal test identities

point_paths_reference.test.mjs (5):

- S05 reference observes point codecs parent order and cache identity under default CPython
- S05 reference observes point codecs parent order and cache identity under CPython 3.12
- S05 reference observes point codecs parent order and cache identity under CPython 3.13
- S05 reference observes point codecs parent order and cache identity under CPython 3.14
- S05 reference rejects caller arguments paths and stdin

point_paths_parent_reference.test.mjs (4):

- S05 reference records managed paths and open native filename cells under default CPython
- S05 reference records managed paths and open native filename cells under CPython 3.12
- S05 reference records managed paths and open native filename cells under CPython 3.13
- S05 reference records managed paths and open native filename cells under CPython 3.14

point_paths_digest_reference.test.mjs (4):

- S05 reference preserves descriptor and observation baselines under default CPython
- S05 reference preserves descriptor and observation baselines under CPython 3.12
- S05 reference preserves descriptor and observation baselines under CPython 3.13
- S05 reference preserves descriptor and observation baselines under CPython 3.14

Thirteen literal top-level identities, three cells. No generated test names, nested subtests, renamed old witness claims or silent skip acceptance. Exact case totals and capability gaps are asserted separately from top-level counts.

## Read-only source pins from this scout

| Path | SHA256 |
| --- | --- |
| tools/contracts/posix-path-bytes/reference.py | 5a51271c11cf812328d31d9864c736bbbdf8bb80e2c27db17d266073c2855325 |
| tests_js/posix_path_bytes_reference.test.mjs | a4e3153c2ff1dfa7a2ef4ba191d07aee8460d0d11122b9f6f7f308c1338dd6aa |
| tools/contracts/managed-resume-path/reference.py | 133a81e18fdbe0265fd49c2908fa79831fc3d1cd958a23e40bbc702ec36a7de4 |
| tests_js/managed_resume_path_reference.test.mjs | e642dfed8368bf2f280d61b6b42f8f3b50264a0c418574677d3085b18cca4f36 |
| tools/contracts/private-file-digest/reference.py | 7dba1564bd23b7659b33550a2eff3f2582794bdac714a50205f40e2ac554b783 |
| tests_js/private_file_digest_reference.test.mjs | 8ea60743e987c0df0f5da922a13f5a8753f58fb506f5782b41313da66284dcd8 |
| tools/contracts/managed-observation/reference.py | d6b170e99a986c5d1a15a134bc6044cd559fa06d2c5381d90d3b49ec104e7a0b |
| tools/contracts/managed-observation/native.py | bf00ae00da09b75cff6da59e5450efb5acfc71a747d48bff1b06fb1f67e6431d |
| tests_js/managed_observation_reference.test.mjs | bbaf38d7ab716f0d0757c09cb7dabef820eb60572dca5abd817581953730821e |
| scripts/job_apply_store/domains/resumes/storage.py | 97ec178e0b3ddc1d3be97b1c6c34983ecf9c50caa9c6f4fd4125dbb71c6db6fe |
| scripts/job_apply_store/normalization.py | 8c299675838779908a1d3876db22fc2d9b32a2e08a890246357193b1d20b2beb |
| scripts/job_apply_store/constants.py | 4438a36055842e18af0ae806fed1f61bf8280908995f7295662a4213226e8b5c |

Final manifest inputs additionally include the complete actual local Python import closure, snapshot/driver helpers, read-only existing source/test tables, exact matrix literal-registration checkpoint, package/configuration and selected interpreter/provenance obligations. Recheck hashes and active ownership before freeze. Do not own source catalogs or S04 modules for this reference task. Reference source fixtures are implemented after plan freeze. The data-only reviewed vectors are prepared and pinned before manifest base; actual captures still require independent review.

## Completion boundary

Done for the scoped reference is exact13 passing literal tests with positive actual profile provenance, full48 new outcomes and88 old records/profile, independently asserted bytes/points/errors/order/cache state, unchanged owned-tree witnesses, complete retained raw captures and an explicit still-open native-filename list. Normal hooks/source-size and independent review of exact committed source/evidence are required. This closes only the reviewed reference observations. It grants no live Store authority, no native raw-byte support claim, no S05 implementation acceptance and no S03 shared consumer activation.

## V2 exact recipe decisions (same48 IDs)

The fixed codec arrays/hex in the matrix are normative. Every ordinary managed record is exactly {storageKind:'managed', managedFile:<case text>} with no unrelated fields. The missing-storage record is {}; missing-file is {storageKind:'managed'}; nonstring-file is {storageKind:'managed',managedFile:1}; empty-file is {storageKind:'managed',managedFile:''}. No id is needed by _managed_resume_path itself. Leaf text is scalar/pair/DCFF/NUL respectively. Invalid parent forms append '/file.bin' to their declared component. Pair-inside-link uses 'inside/'+pair; pair-outside-link uses 'outside-link/'+pair. ASCII symlink targets stay '.' and '../outside'. Both resolve faults use managedFile='file.bin', with OSError(5,'synthetic resolve') at the stated first/second call.

Do not collapse failures: missing storage→StoreError('resume is not managed'); missing managedFile→KeyError('managedFile'); integer managedFile→actual pathlib join TypeError before any resolve; empty text→parent(root) then root resolution followed by StoreError('managed resume file identity is invalid'). Actual TypeError profile wording and invalid-parent encoding/NUL precedence are full capture assertions. OSError wrapping suppresses cause but preserves context; UnicodeError/ValueError are not caught by that except OSError.

Each cache sequence starts with a new empty dictionary and a distinct owned ASCII file named file.bin containing exact bytes 'synthetic observation bytes'; no cross-case cache state. Managed records are exactly {storageKind:'managed',managedFile:'file.bin',id:<typed case key>}. All clocks begin at2026-01-02T00:00:00+00:00. Ordinary two-call cases use the same clock; expired-pair uses t0, t0+OVERVIEW_DIGEST_CACHE_SECONDS, then that same expiry instant for a third equal-text lookup. The constant's actual pinned value is used, not a silently duplicated guessed number.

Equal text instances use prefix points[105,100] plus pair/scalar, constructed independently; assert equality and distinct object identity. Pair-versus-scalar uses those same prefixed forms. Escape-versus-scalar uses [105,100,56575] then[105,100,255]. NUL and empty sequences use keys[0] and[] respectively on both calls; these keys are never filenames. Text-versus-numeric sequence is text points[49], integer1, float1.0, bool true in that order. Stat metadata comes from the unchanged owned file; record all native values and compare exact relationships, while injected stable clock is labeled. Digest must read actual bytes. Hits suppress digest/second-stat; TTL equality misses then the following equal-time access hits.

Independently derived codec anchors: encode scalar=f0908080, encode NUL=00, DC80/DCFF=80ff. Decode eda080edb080 yields[56557,56480,56448,56557,56496,56448], not a surrogatepass pair; f09080 yields[56560,56464,56448]. The full48-case data candidate is prepared, including exact resolved-root Unicode error formulas; actual cache/path capture and independently copied88 baseline records still require review before acceptance. Existing five macOS unavailable native filename cells remain open.

## V2 refusal byte contract and current input closure

Refusal stderr is Buffer.concat([Buffer.from('point_paths_reference_input_rejected','ascii'),Buffer.from([10])]); this specifies bytes, not runnable fixture data. Exactly one final LF, no CR and no literal backslash-n. Expected stdout is empty and status is2 for each existing argv/nonempty-stdin probe. No new probe identity or command is introduced.

Static source pins below were rechecked unchanged at2da2e1f52709c967915318a661b09339d2d3e49a. They are input provenance, not runtime evidence. Package initialization imports base/io/normalization and five validators even when the reference imports one leaf. Include the common13 rows plus the relevant domain initializer/leaf; S04 requires coordinator persistence, S05 requires resume storage. Resolve any additional actual new-helper imports at freeze.

| Path | SHA256 |
| --- | --- |
| scripts/job_apply_store/__init__.py | d1f3908a9875fdeda94a2d1823b0e42edb29c7814a638b8edcdc15e127052a04 |
| scripts/job_apply_store/base.py | e1deee9f49d012eac54f3ef4990c7641d43874afa699c8d12d79919599f27c88 |
| scripts/job_apply_store/constants.py | 4438a36055842e18af0ae806fed1f61bf8280908995f7295662a4213226e8b5c |
| scripts/job_apply_store/errors.py | be48cff00389f30d0f51f95ec154baec6162a57350b2ab3cfcb531da7456e01c |
| scripts/job_apply_store/io.py | 6e4b36c224fdf34924f14fecbd6d8afaf398afcff455509b85a817008c407d53 |
| scripts/job_apply_store/normalization.py | 8c299675838779908a1d3876db22fc2d9b32a2e08a890246357193b1d20b2beb |
| scripts/job_apply_store/domains/__init__.py | b112b206edd338aa0dd2a17d1414be2c843d6d44337249d59079a82129cd0c26 |
| scripts/job_apply_store/validation/__init__.py | b8e8d8f492cf48c33321d01db8899357f333cf94b93e5f20835cce62104524e3 |
| scripts/job_apply_store/validation/accounts.py | aa62b41eabe54f13c3b3fbb9791dedafc98dbac9d4e68262452e69bfb2457ddc |
| scripts/job_apply_store/validation/extraction.py | 6437704da0aefe5b3351c129a5b3e36e49da4db9a8d56c60ba19d28825b5d7d8 |
| scripts/job_apply_store/validation/jobs_resumes.py | 1ad4bffefc7cc6a605d2fa04b0d2e1ccb5804091064083787f4126c157274c83 |
| scripts/job_apply_store/validation/profile_answers.py | 599715a998b68fb0ac1ab67c0930564fda9fb69206084c12dafccfb83c9e65d9 |
| scripts/job_apply_store/validation/sessions.py | 9d1c6158facc0724e5500defbc8027931e2112927677d9f3b79d5a8fde5339ce |
| scripts/job_apply_store/domains/resumes/__init__.py | 9ff7cd33ef9e3c17454ac38ab147f3eaec75e44816a6ea8fa0a5d3fa381dfba0 |
| scripts/job_apply_store/domains/resumes/storage.py | 97ec178e0b3ddc1d3be97b1c6c34983ecf9c50caa9c6f4fd4125dbb71c6db6fe |
| scripts/job_apply_store/domains/coordinator/__init__.py | 8515203ac4bc80d5d722deffa1879e08518b2a200a7bdbab5425c8dee43ee1be |
| scripts/job_apply_store/domains/coordinator/persistence.py | 1296863bad9412b852879a3b9c653a98ca61375811df2690600e6f69bc7c3177 |


S04 baseline wrappers also bind tools/migration/tap-evidence.mjs and its transitive imports, unchanged baseline drivers/support/test assertions and actual Node/package/matrix inputs. S05 direct drivers bind unchanged four reference drivers plus managed-observation/native.py and four original independent assertion sources. Neither requires editing those inputs. Keep all original owned paths, cells, test identities, time/output budgets and baseline obligations. Audit JSON v2 is structurally unchanged; this plan supplies precise fixture/input obligations without introducing unrecognized audit fields.

All five literal registrations are committed at2da. Recheck active ownership, exact pins and DAG/receipt bindings at the fresh manifest base; retain these reviewed data hashes. Full reference execution and independent acceptance remain required.

## Exact reviewed data and diagnostic provenance

Normative data candidate: S05-reference-final-vectors.json; SHA256 4c6af618ffbea1ad274b7d98dc12669c2d38fcb2b3ce72080e5afe5cf14a7967. Prepare it at docs/migration/evidence/s05/reference-vectors.json before the fresh manifest base. It contains no executable probe text.

- S05-invalid-parent-probe.py: SHA256 bd2964d765507afc408ce4f9c681a475ea55c7241e3204b1b03c78c4e364dd8e
- S05-invalid-parent-observations.json: SHA256 8260abb89d1cdca9adedd41700a26c054c0401efa6b7ec4e15f1958ad21afa04
- S05-invalid-parent-provenance.json: SHA256 61c4676887805e8993d18ceadff756cd6305ba0abd123edd53283d58a9360d3f

These external provenance files preserve bounded diagnostic raw stdout and hashes; they do not replace the full registered test cells or accept the reference. Source revision for the probes is2da. No future commit SHA is implied.

All three invalid-parent error contracts are now explicit: NUL ValueError has exact lstat message; pair errors bind the independently resolved valid owned-root prefix plus fixed component and exact codepoint offsets/message. Preserve /private/var expansion rather than normalizing it away. Cache expectations remain POSIX-only and await actual full reference validation; five macOS raw-filename setup cells remain open.
