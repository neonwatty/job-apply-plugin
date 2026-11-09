# TypeScript transition and pre-merge guide

This guide compares staging's native workflow with the Python v1.1.0 release at
`07f18ee3c8854df74746492c7a4728fcdf302ff5`. It describes the transition being
prepared for main; it does not announce that main has changed or a release has
been published. Existing answer reuse, job search, preferences, and human-only
submission remain part of the product.

## Features added since the Python release

| Area | Added on staging |
| --- | --- |
| Runtime | TypeScript Store, task, attempt, policy, and QA replay routes; Node-only required CI; verified native lock addons for macOS arm64 and Linux x64. |
| Companion | A local Next.js/React app with a Focus Queue layout and collapsible sidebar. Navigation includes Overview, Jobs, Needs Attention, Facts, Resumes, Answers, Automation, Accounts & Sign-in, Settings, and unified Trash. Application Activity belongs to the selected job. |
| Skills | Application Setup, Account Setup, Saved Jobs, Job Title Discovery, and Job Workspace supplement the original four skills. |
| Jobs | Canonical saved jobs with revisions and lifecycle states, selective legacy-report import, exact-job preparation, recoverable claims, and value-free progress/attention views. |
| Resumes | Private managed PDF/DOCX/TXT copies, stable resume identities, per-resume draft/confirmed facts and history, extraction requests, and exact resume/fact selection for an application run. |
| Fact editing | Draft preservation on refresh and conflicts, nested fact controls, exact large integers and numeric input, explicit reload/discard, and confirmation of one fact revision. |
| Answers | Companion review of reusable answers and observed questions, explicit sensitive reveal/retention consent, exact-scope winner selection for merging duplicates, and guarded restore/delete. |
| Owner setup | Saved browser/fallback/pace preferences, separate search/application model defaults, and Guided, Autofill to Review, or bounded Campaign to Review modes. Saving preferences does not grant authority or launch a task. |
| Recovery | Revision-checked mutations, retained migration backups, guarded Trash, explicit conflict review, and interrupted work in Needs Attention. |

Companion queues extraction or copies a host invocation; it does not launch an
agent, extract facts itself, or submit applications. Confirm the exact resume
and fact revision with the agent before an application run. Authentication,
verification, sensitive-use decisions, and final submission remain owner actions.
See the [workflow map](../skills/answer-memory/references/workflow-map.md) and
[resume-scoped facts](resume-scoped-facts.md).

## Installation and first launch

- Install Node.js 22 or newer in the host's launch environment. The plugin does
  not include or download Node. The bundled native lock is a Node addon.
- Supported package targets are macOS Apple Silicon (arm64) and Linux x64.
  Windows and other architectures are not certified by reference tests.
- Follow the [host installation steps](../README.md). For an unreleased branch,
  install from an isolated checkout of the exact candidate and confirm the
  selected installed version before starting a new host session.
- A source-only Companion install needs npm and package-registry access on first
  launch to install the pinned lockfile and build its server. Later launches
  reuse that build until a plugin refresh; refreshing may require another build.
  Ordinary Store/CLI operations do not need this Companion dependency install.
- Open Companion only when requested using Job Workspace. Keep the launcher
  attached; use its complete newly printed local URL and stop it with Ctrl-C.
  Never copy its fragment token into a chat, issue, or diagnostic log.

## Upgrading and recovery

Follow the [Store upgrade and recovery guide](../skills/answer-memory/references/upgrade.md)
before the first data command or Companion launch. That guide is included in the
installed skill tree so agents can read it without repository-only documentation.
It covers stopping older writers, private backups, activation on read requests,
the retained `.python-rollback` directory, and recovery using a separate copy.
The installed package has no Python rollback command; a migration-time backup
never includes later native edits.

## Pre-merge acceptance

The [testing guide](testing.md) defines the commands and supported cells:

1. Run affected required checks against the intended base and the release tier.
   Run `npm run check:migration` from a clean checkout with full Git history to
   verify inventory consistency and the frozen historical boundary.
   Required CI is TypeScript-only, including native adapters and installed
   Codex/Claude package, cache-upgrade, browser, and restart checks.
2. Run the separate one-time historical Python Store migration acceptance on
   the exact candidate. Its manual workflow covers Linux and macOS and retains
   a value-free receipt with the candidate commit and working-diff digest.
   It creates fictional state through the pinned Python release, verifies native
   activation/backup/restart/rollback, then reads the restored Store with Python.
   It never tests migration on the owner's real data.
3. Review the candidate against the intended integration base, resolve validated
   findings, and require a green PR gate. Keep the actual run URLs and receipts;
   neither an earlier commit's result nor a dirty-checkout receipt certifies a
   different final candidate. Documentation-only follow-ups still need their
   applicable checks and a clearly identified runtime acceptance candidate.
4. Before a main merge, confirm the version/install identity and evidence limits.
   The current Codex manifest is 1.3.5. Do not infer a new published release or
   fresh-host Node guarantee from that manifest, CI, or this guide.

Live agent/browser account canaries and broader ATS acceptance remain separate
explicitly authorized work. Synthetic package/browser checks do not establish
live form coverage. The documented live evidence remains the narrow Pinterest
Greenhouse review observation; final submission is always manual. Historical
migration/DAG receipts and Python research pages describe their original scope,
not additional required CPython CI or a claim of current platform certification.
