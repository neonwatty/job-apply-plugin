> The companion is optional and now installed independently. Agent/CLI setup does not require it. See [installation and lifecycle](../companion/README.md).

# Set up Job Apply

## Before you start

Install the plugin using the [installation instructions](../README.md#installation),
then start a new host conversation so it loads the installed skills.

The Python release is validated with Python 3.12. Check `python3 --version` on
macOS/Linux or `py -3.12 --version` on Windows. If Python is missing, install
Python 3.12 and reopen your terminal and host. Other Python versions are not
established by this release's cross-platform acceptance checks.

You do not need Node, npm, Playwright, or a frontend build to use the workspace.
The browser integration described in the README is needed for agent interaction
with application sites. The local workspace opens in your default browser.

## From installation to your first prepared job

1. **Open the workspace.** Invoke `$job-apply:job-workspace` in Codex or
   `/job-apply:job-workspace` in Claude Code. The agent resolves the installed
   plugin location and launches the workspace. Keep the launcher process running.
2. **Import a resume.** From Overview choose **Open Resumes**. Give the file a
   label and import a PDF, DOCX, or UTF-8 TXT file, up to 10 MiB. Job Apply keeps
   a managed copy; importing does not edit your source document.
3. **Ask the agent to extract facts.** Choose **Request fact extraction**, then
   **Copy agent handoff**. Paste the handoff into your Codex task or Claude Code
   session. Copying or queuing a request alone does not start an agent.
4. **Review the result.** Return to **Facts** to check the extracted information.
   Extraction can fill absent, unprotected facts. Open the resume's **Manage**
   details and **Extraction reviews** for changes requiring your decision.
   Accept only changes you want; resolve conflicts explicitly.
5. **Prepare a job.** Open **Jobs**, choose **New job**, and save the opportunity.
   Open its details, choose **Run ready check**, resolve listed blockers, and
   mark it **Ready**. Use resume details to choose a default if needed.
6. **Hand off when ready.** Copy your host's Job Apply command from Overview and
   paste it into that host. The agent prepares the application and stops for your
   review. You control final submission on the application site.

## Stop and return later

Closing the browser tab does not stop the server. Press Ctrl-C in the launcher
process to stop it, or ask the launching agent to stop that process.

Invoke the workspace skill again to return. Your saved work remains local.
Use the newly opened page or the complete URL printed by the new launcher;
an old bookmark may contain an expired connection token. Unsaved browser edits
are not a substitute for saving before stopping.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Skill is missing | Confirm installation in the intended host, then start a new conversation. |
| Python command is missing | Install Python 3.12 and reopen the host. On Windows, check the `py -3.12` launcher and ask the agent to use that interpreter. |
| Browser does not open | Keep the launcher running and open its complete printed URL locally. Do not paste the token-bearing URL into chat or issues. |
| Old page cannot connect | Start the workspace again and use its newly printed URL. |
| A chosen port is occupied | Omit `--port` so the launcher selects a free one. |
| Extraction stays waiting | Paste **Copy agent handoff** into an active host conversation and ask it to process the request. |
| A record changed elsewhere | Refresh the record, review the preserved draft, and explicitly reapply your changes. |
| Store recovery message appears | Stop the workspace and preserve the data directory. Follow the recovery guidance; do not delete or reset your Store to bypass it. |

For a manual launch, resolve the installed plugin directory and run:

```text
python3 "<source-checkout>/companion/install.py"
python3 ~/.local/share/job-apply-companion/companion.py
```

On Windows with the Python launcher, use `py -3.12` in place of `python3`.
For isolated development QA, add `--root <synthetic-store-directory> --port 0
--no-open`. Never use the same Store for Python and TypeScript migration writers.
