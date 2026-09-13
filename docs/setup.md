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

1. **Ask the agent to set up your resume.** Supply its local path, or let the
   agent ask for it. It imports a managed copy and completes fact extraction;
   no UI installation or copied extraction handoff is required.
2. **Review the result in the conversation.** Check contact details, work history,
   education, and skills. The agent flags uncertainty and preserves existing
   confirmed facts. Choose explicitly how to resolve proposed conflicts.
3. **Choose job intake.** Supply a job URL, point to a browser page and select a
   count/filter, or use manual Jobs entry in the optional companion. The agent
   previews and saves the authorized selection, preserving existing job states.
4. **Read the automatic readiness results.** After agent intake, it checks saved
   jobs without another prompt. It uses an assigned resume, default, or sole
   active resume. A damaged file stays blocked; multiple resumes without an
   assignment/default require your choice. Passing checks leaves jobs saved.
5. **Choose when to apply.** Explicitly select the job to prepare. Readiness
   alone does not start an application. Final submission remains yours.

To review or edit in a browser, install the [optional companion](../companion/README.md)
and invoke the workspace skill. Manual resume upload and extraction handoffs
remain available there. For manual job entry, the agent can check your saved
selection when you return to the conversation.

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

To install and launch the optional companion from a source checkout:

```text
python3 "<source-checkout>/companion/install.py"
python3 ~/.local/share/job-apply-companion/companion.py
```

On Windows with the Python launcher, use `py -3.12` in place of `python3`.
For isolated development QA, add `--root <synthetic-store-directory> --port 0
--no-open`. Never use the same Store for Python and TypeScript migration writers.

## Edit facts in the optional companion

Choose a fact tab such as Work history, Education or Skills. Use Left/Right or
Home/End while a tab has focus. Switching tabs preserves drafts. The sticky
**Save changes** button saves edits across every tab; Ctrl/Cmd+S does the same
when no dialog is open. Drafts still need saving before stopping the companion.

For a promotion, choose **Add promotion** on a work-history position and enter
the new role and dates. The draft copies only the company and description.
**Copy description to company roles** asks before replacing descriptions for
other positions with the same company name. Review the drafts and save when
ready. Conflicting changes from another client still require explicit review.

### Finding your data in the companion

The sticky navigation groups destinations under Pipeline (Overview, Jobs, Needs
Attention), Application Data (Facts, Resumes, Answers), and Controls (Automation,
Trash). Select a group to open its destinations; on smaller screens, open **Menu**
first. Escape closes a dropdown and returns focus to its group. In Facts, use the
section tabs to focus a section; switching tabs retains drafts. The page title follows the selected section. **View readiness** opens a side
panel without leaving your draft; the full checklist lives on Overview. Close
it with Escape, the close button, or a click on the backdrop. The
header’s sun/moon button switches light and dark mode and remembers your choice.
Until you choose, it follows your system theme.
Managed resume cards offer **View PDF**, **Preview text**, or **Download DOCX**.
PDF viewing opens your browser's PDF viewer in a separate tab; browser settings
may instead download it. PDF is optional; DOCX and TXT remain supported.
