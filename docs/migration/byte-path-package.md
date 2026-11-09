# POSIX filesystem byte adapter package

Reference base: `6e36bb8`. Parent FS/SEM gates remain open. The reference has
eleven observed cases and five unavailable native filename cases per profile on
this macOS filesystem; those unavailable cells do not grant acceptance.

Implementation owner migration_sequence has exact `allowed_files`:
`src/contracts/posix-path-bytes.ts` and `src/contracts/posix-path.ts`.
Independent test owner numeric_codec has exact `allowed_files`:
`tests_js/posix_path_bytes_ts.test.mjs` and
`tests_js/posix_path_bytes_ts_support.mjs`.
validation_strategy reviews source independently. The coordinator owns runtime
emission, inventory registration, package documentation and the execution ledger.
Emitted files are `runtime/contracts/posix-path-bytes.js` and the existing
`runtime/contracts/posix-path.js`. No Store facade or routing changes are allowed.

The codec exports `filesystemEncode` and `filesystemDecode`. Its contract is UTF-8
with Python filesystem surrogateescape: every invalid byte maps to U+DC80–U+DCFF
and re-encodes to the original byte, valid Unicode scalars retain ordinary UTF-8,
and unencodable standalone surrogates raise the UnicodeEncodeError category.
Native filesystem calls consume Buffer paths and read raw link-target bytes.
Encoding precedes NUL validation; final managed-path leaves remain lexical.

Completion requires comparisons with actual Python encoding/decoding, separate
owned native path fixtures, preserved tree bytes/modes/mtimes, independent review,
strict typechecking, reproducible emission, size and inventory checks. Commands:
`node --test tests_js/posix_path_bytes_ts.test.mjs`, the existing managed-path tests,
`npm run typecheck`, `npm run build:runtime`, `npm run build:check`,
`npm run check:size`, `npm run check:test-matrix` and `npm run check:migration`.
Missing native cases remain explicit skips, never successful parity receipts.

The input domain includes losslessly decoded filesystem strings and compatible
JSON strings. Two literal Python surrogate code points that occupy a high/low pair
cannot be distinguished from a JavaScript astral scalar without a richer string
transport; this codec does not claim to solve that separate ingress distinction.
Native Windows and byte-named current directories on Linux remain required work.
The current Node cwd string boundary is not evidence for raw-byte cwd support.
Neither the codec nor parent-path comparison establishes race-safe file opening.
