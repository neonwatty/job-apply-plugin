# Repeatable QA Chrome Launcher Implementation Plan

**Goal:** Replace the ad hoc remote-debugging Chrome command with a repeatable, identity-safe workflow for creating, checking, stopping, and resetting dedicated persistent QA browser profiles.

**Initial scope:** macOS-first. The design keeps platform discovery behind a small boundary so Linux support can be added without changing the command contract. Tests use injected executables and local synthetic endpoints; they never require a LinkedIn account.

**Safety model:** The helper may manage only profiles it created below its private root. It must never inspect or stop ordinary Chrome, print tab URLs, persist credentials, attach to a login page, or infer that a user has consented to advance a live application. Manual login, CAPTCHA, MFA, job selection, recording start, and final submission remain user-controlled.

## User-facing command contract

```bash
python3 scripts/qa-chrome.py start --profile linkedin-capture
python3 scripts/qa-chrome.py check --profile linkedin-capture
python3 scripts/qa-chrome.py stop --profile linkedin-capture
python3 scripts/qa-chrome.py reset --profile linkedin-capture
```

`start` creates the named profile on first use and reuses it later. It launches Chrome with a loopback-only, dynamically assigned CDP port and prints one closed JSON object:

```json
{
  "profile": "linkedin-capture",
  "status": "ready",
  "cdpUrl": "http://127.0.0.1:49152",
  "recorderCommand": "node qa/recorder.mjs record --cdp-url http://127.0.0.1:49152 --output .qa-private/REPLACE_WITH_UNIQUE_SESSION_ID"
}
```

The output must not include expanded browser profile paths, tab titles, tab URLs, cookies, process IDs, tokens, or Chrome command lines. `check` and `stop` also return closed, value-free JSON. A safely stopped, unambiguous `reset` returns closed manual-removal guidance containing only the literal dedicated path `~/.job-apply-qa/chrome-profiles/<profile>`. Expected operator errors use stable diagnostics on stderr and exit nonzero.

`reset` is deliberately separate from `stop`. It refuses an active or ambiguous profile, performs no mutation, and identifies the exact dedicated profile directory for a user-owned manual removal. It never opens Trash, inspects profile contents, or moves, renames, unlinks, removes, or deletes browser data.

## Runtime architecture

### Private filesystem layout

The helper owns this macOS-local tree outside the repository:

```text
~/.job-apply-qa/                 0700, current user
  chrome-profiles/               0700
    linkedin-capture/            0700, persistent Chrome user-data-dir
  runtime/                       0700
    linkedin-capture/            0700, one active generation
      state.json                 0600, closed non-sensitive state
      control.json               0600, supervisor port + 256-bit token
      lock                       0600, exclusively held by supervisor
```

Every component is opened without following symlinks and checked for current ownership, exact private modes, ordinary file/directory type, device/mount boundary, and stable inode identity. Profile identifiers use `^[a-z0-9]+(?:-[a-z0-9]+)*$` and are never accepted as paths.

### Authenticated supervisor

`start` spawns an internal `supervise` process. The supervisor:

1. Exclusively locks the named runtime directory.
2. Launches the exact discovered Chrome executable as its child with:
   - `--user-data-dir=<managed profile>`
   - `--remote-debugging-address=127.0.0.1`
   - `--remote-debugging-port=0`
   - `--no-first-run`
   - `--no-default-browser-check`
   - `--new-window`
3. Reads a newly written `DevToolsActivePort`, rejecting stale or substituted files.
4. Verifies the loopback `/json/version` endpoint and child liveness without reading `/json/list` or tab URLs.
5. Starts a random loopback control port protected by a 256-bit bearer token.
6. Publishes ready state only after Chrome and the authenticated control channel are ready.
7. Retains the exact child handle until Chrome exits.

`stop` never calls `ps`, matches command-line substrings, or signals a PID read from disk. It authenticates to the retained supervisor, which terminates only its child, waits within a deadline, escalates only through that retained handle, removes runtime control state, and exits.

If the supervisor is missing or authentication/identity checks fail, the helper reports `profile state is ambiguous` and leaves Chrome untouched. Recovery instructions tell the tester to close that dedicated window manually; the helper does not guess.

### Profile persistence

The persistent profile may retain LinkedIn cookies and login state, so it is treated as credential-bearing private data:

- It is never stored in or below the repository.
- It is never scanned, archived, copied, or included in diagnostics.
- The helper never reads Chrome databases, cookies, history, tab state, or page content.
- `check` probes only supervisor identity, child liveness, and `/json/version` readiness.
- `reset` is non-mutating guidance; Finder or terminal removal is an explicit user-owned action targeting only its literal tilde-form path.

## Implementation tasks

### Task 1: Define and test the closed CLI and filesystem contracts

**Files:**

- Create `scripts/qa-chrome.py`
- Create `tests/test_qa_chrome.py`

Write failing tests first for:

- Profile identifier validation and closed JSON output.
- Private root/profile/runtime ownership and exact modes.
- Symlink, special-file, mount/device, ancestor-swap, and unsupported-platform refusal.
- No tab URL/title/expanded profile path/PID/token leakage in stdout or stderr; the only path exception is `reset`'s literal dedicated tilde-form guidance.
- `start`, `check`, `stop`, and `reset` argument contracts.
- Non-mutating reset guidance and refusal while active or ambiguous.

Implement pure parsing, path-binding, permissions, JSON framing, and platform-discovery functions. Add a macOS Chrome discovery allowlist in this order:

1. Explicit `--chrome-path` only in test/developer mode, requiring an absolute regular executable.
2. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
3. `$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

Do not search the filesystem or accept a shell command.

### Task 2: Implement the authenticated supervisor lifecycle

**Files:**

- Modify `scripts/qa-chrome.py`
- Modify `tests/test_qa_chrome.py`

Build a synthetic Chrome executable for tests that creates `DevToolsActivePort`, exposes a minimal loopback `/json/version`, and records signals without emitting browser data.

Test and implement:

- First start and persistent-profile reuse.
- Dynamic port discovery and stale `DevToolsActivePort` rejection.
- One active supervisor per profile under concurrent starts.
- Startup timeout and cleanup before readiness.
- Authenticated `check` and `stop`.
- Ordinary Chrome/look-alike process preservation.
- PID reuse and substituted runtime-state refusal.
- Bounded graceful stop followed by child-handle-only escalation.
- Chrome exiting independently and stale-runtime recovery.
- Ctrl-C/SIGTERM behavior without orphaning control state.

The supervisor protocol must use closed request/response schemas, exact Host/Origin/content-type checks where applicable, bounded bodies, constant-time token comparison, deadlines, and value-free errors.

### Task 3: Add a real local Chrome/CDP integration test

**Files:**

- Modify `tests/test_qa_chrome.py`
- Optionally modify `.github/workflows/validate.yml` only if the test can run reliably on the existing Linux CI image

Use an injected Chromium/Chrome executable in a temporary private profile to verify:

- `start` returns a working loopback CDP URL.
- The existing recorder can connect to that endpoint.
- `check` reports ready without enumerating tabs.
- `stop` closes only the launched browser.
- The profile persists across a second start.

The macOS Chrome discovery branch receives unit coverage on CI and a documented local acceptance command. Linux auto-discovery is a follow-up unless it can be included without weakening the executable and process-identity boundaries.

### Task 4: Implement non-mutating manual-reset guidance

**Files:**

- Modify `scripts/qa-chrome.py`
- Modify `tests/test_qa_chrome.py`

Test and implement a guidance-only reset flow:

1. Bind and validate the managed root and named profile by descriptor/identity.
2. Prove there is no active or ambiguous supervisor.
3. Return `{"profile":"linkedin-capture","status":"manual-removal-required","profilePath":"~/.job-apply-qa/chrome-profiles/linkedin-capture"}`.
4. Leave the profile and all of its contents unchanged.

Refuse active or ambiguous state without emitting a path or saying removal is safe. Never inspect profile contents or call rename, unlink, rmdir, a deletion primitive, or any Trash API. Finder or terminal removal is a separate user-owned action; the launcher neither executes nor authorizes it and requires no Trash permission.

### Task 5: Integrate the launcher into the recorder runbook and validation

**Files:**

- Modify `README.md`
- Modify `scripts/smoke-plugin.sh`
- Modify `.github/workflows/validate.yml` only if Task 3 adds a deterministic CI lane

Replace the hand-written Chrome launch instruction with the four helper commands. Document this sequence:

1. `start` the named profile.
2. Manually sign in and complete MFA/CAPTCHA.
3. Close unrelated tabs and open a genuine intended application.
4. Run the emitted recorder command only on the application page.
5. Stop the recorder cleanly before stopping Chrome.
6. Use `stop` after capture.
7. Use `reset` after `stop` to obtain the exact dedicated path only when intentionally considering manual removal of retained authentication.

The smoke package must include the launcher and exclude all external QA profile/runtime data. Static assertions should reject documentation that reintroduces a fixed port or direct `open ... --remote-debugging-port` recipe as the primary workflow.

## Verification commands

```bash
python3 -m unittest tests.test_qa_chrome -v
python3 -m unittest discover -s tests -v
npm ci
npm run test:qa-browser
bash scripts/smoke-plugin.sh
bash scripts/check-links.sh
python3 -m py_compile scripts/qa-chrome.py tests/test_qa_chrome.py
git diff --check
```

Local macOS acceptance, using a non-production test profile:

```bash
python3 scripts/qa-chrome.py start --profile launcher-acceptance
python3 scripts/qa-chrome.py check --profile launcher-acceptance
python3 scripts/qa-chrome.py stop --profile launcher-acceptance
python3 scripts/qa-chrome.py reset --profile launcher-acceptance
```

## Acceptance criteria

- A tester can repeat the same four commands without remembering Chrome flags or ports.
- Login state persists between normal stop/start cycles.
- The CDP listener is loopback-only and its port is dynamically allocated.
- The recorder command always uses the verified current CDP URL.
- No command prints or persists tab URLs, credentials, cookies, tokens, expanded profile paths, or unrelated process information; only a safe `reset` prints its literal dedicated tilde-form guidance path.
- `stop` can affect only the exact Chrome child retained by the authenticated supervisor.
- Ambiguous state fails closed and never triggers a process signal.
- `reset` is identity-bound and non-mutating, needs no Trash permission, and returns only the literal dedicated tilde-form profile path when removal guidance is safe.
- Existing Python, browser, smoke, privacy, and link checks remain green.
- The first real LinkedIn fixture capture uses this launcher rather than an ad hoc Chrome command.

## Deferred follow-ups

- Linux Chrome/Chromium auto-discovery and desktop integration.
- Profile expiration reminders or optional scheduled rotation.
- Multiple simultaneous named QA profiles.
- A higher-level `capture` coordinator that starts Chrome and the recorder together. This remains separate because manual login and choosing the genuine intended application must occur before recording begins.
