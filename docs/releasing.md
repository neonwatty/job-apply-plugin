# Releasing Job Apply

Job Apply and Companion ship from the same Git commit. The public marketplace
entries point to `stable`. The opt-in `preview-catalog` branch contains the
Codex and Claude Code catalogs that point to `main`. A stable release has a
`vX.Y.Z` Git tag. Identify a preview by its source commit SHA. [Installation and update commands](../README.md#installation)

## Publish a stable release

1. Merge the release notes and update `version` in `.codex-plugin/plugin.json`
   to match the planned tag, without the leading `v`. Select the exact reviewed
   commit on `main` that contains both release workflows.
2. For a hosted validation rehearsal, dispatch **Release Validation** on `main`
   with the selected full commit SHA in `checkout_sha`. Its macOS and Linux jobs
   validate installed copies of the plugin and Companion.
3. Create and push the annotated tag on the selected SHA, then publish its
   stable release in GitHub Releases. **Promote Stable Release** validates the
   tagged SHA and advances `stable` after both platform jobs pass.
4. Confirm the promotion outcome and final `stable` SHA in the workflow
   summary. Check the default install path in Codex and Claude Code and launch
   Companion against a disposable local Store. [Promotion workflow](../.github/workflows/promote-release.yml)

## Promotion identity

The promotion job uses the `stable-release` GitHub Actions environment. Configure
`JOB_APPLY_RELEASE_APP_CLIENT_ID` as an environment variable and
`JOB_APPLY_RELEASE_APP_PRIVATE_KEY` as an environment secret. The private GitHub
App is installed on this repository with Contents read and write access. The
environment is available to tags matching `v*`.

The `stable-promotion-writer` ruleset allows that app to update `stable`.
The separate `stable-integrity` ruleset prevents deletion and force pushes.
The `release-tag-integrity` ruleset protects release tags from moves and deletion.

## Retry or recover

If the release validation fails, the previous stable commit keeps serving
installs. Rerun the original workflow for transient failures. For a code
correction, merge the fix into `main` and publish a new patch release. Use a
reverting patch release if the earlier release has already been promoted.

Use the SHA of `stable` to identify what people can install while a published
release is still validating. The [stable branch](https://github.com/neonwatty/job-apply-plugin/tree/stable)
and the promotion run summary both show the commit.
