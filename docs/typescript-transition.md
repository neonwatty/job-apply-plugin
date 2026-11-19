# Upgrading to the TypeScript plugin

The plugin runs on Node.js 22 or newer on macOS Apple Silicon, Linux x64, and Windows x64.
[Install the plugin](../README.md#installation), then start a new Codex or
Claude Code chat. Companion is an optional local app still under development.
The plugin supports resume setup, fact review, and applications with the app closed.

## Upgrade your Store

1. Stop older plugin sessions, Companion servers, and application attempts.
2. Back up the complete private Store before the first data command.
3. Start a new chat with the updated plugin and review your existing records.
   The first data command can activate the TypeScript Store and retain a
   migration-time backup.

Follow the [Store upgrade and recovery guide](../skills/answer-memory/references/upgrade.md)
for backup locations, compatibility limits, and restoring a separate copy.
Read the [resume facts guide](resume-scoped-facts.md) before choosing a resume
and confirmed fact revision for an application.

## Open Companion when you need it

Invoke `$job-apply:job-workspace` in Codex or `/job-apply:job-workspace` in
Claude Code and open the complete local URL printed by the launcher. The first
launch from a source install needs npm and registry access. Keep the URL private
and stop the launcher with Ctrl-C.

For development and release checks, see the [testing guide](testing.md).
