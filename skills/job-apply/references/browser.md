## Browser Routing

Use the active host's supported visible browser integration so the user can see navigation, authenticated state, entered values, uploads, and the final review page.

- **Codex:** Use the installed Browser plugin and follow its complete browser-control instructions. When the job URL is known, let the Browser runtime select the appropriate in-app or Chrome surface for that URL. Reuse that browser binding and visible tab throughout the application. Do not substitute an unrelated browser automation server.
- **Claude Code:** Use Claude in Chrome as the default and only required browser integration.

### Visible-Browser Rules

- Use Codex Browser/Chrome or Claude in Chrome for LinkedIn and every external application portal, according to the active host.
- Use the user's existing authenticated Chrome session, but never ask for, read, store, or enter credentials.
- Pause for the user to handle login, password, CAPTCHA, MFA, consent prompts, or account creation.
- Use Chrome's visible form controls and local file-upload support. Confirm the selected filename after an upload.
- If an Apply link opens an external portal or a new tab, continue there in the same host-managed visible browser session.

### Optional Browser Fallback

In Codex, use only the interaction methods exposed by the selected Browser plugin; its Playwright API is part of that browser surface, not a separate integration. In Claude Code, a separate Playwright integration is not required and may be used only when **all** of the following are true:

1. The user already has a Playwright integration configured in Claude Code.
2. Claude in Chrome cannot reach a specific iframe, upload widget, or custom control after a reasonable visible attempt.
3. The fallback does not require transferring login state or credentials.

Use the fallback only for the blocked control, then return to the visible review workflow. If these conditions are not met, explain which field is blocked and leave it for the user to complete manually.

---

### Post-readiness action-time consent

Action-time consent has a closed, one-use state transition:

1. Before the exact application form is visibly ready, consent is `not_ready`. Earlier approval, a URL or job selection, consent from another application, and blanket future consent are invalid and cannot authorize entering data.
2. After the visible form is read, establish `ready_unconfirmed` only when the exact data scope, destination, purpose, remembered-answer use, and review-only limit are known. Ask for explicit action-time consent unless the owner's current message was sent after that visible readiness and already explicitly authorizes those same bounds.
3. That matching post-readiness authorization transitions once to `consent_consumed` for the bounded filling pass. Proceed without asking for the same confirmation again. It is not reusable for another job, destination, purpose, attempt, or future application.
4. A material change to the data scope, destination, or purpose invalidates the consumed consent. Read the changed visible state and obtain new explicit post-change consent before entering more data. Ordinary page progression within the unchanged bounds, a value-free status update, or the final manual-review handoff is not a material change and must not trigger duplicate confirmation.

This action-time consent does not replace field-specific sensitive-answer consent, remember consent, login or account consent, or the manual final-action boundary. Never echo raw applicant values in chat, summaries, diagnostics, or receipts. Describe only field names or groups, counts, and states such as complete, incomplete, uncertain, or awaiting owner input. The values remain visible only in the owner-visible form where they were entered.

### Verified field entry

Treat a browser write that returns without an error as an attempted write, not proof
that the field accepted the value. Apply this bounded loop to every editable control:

1. Resolve the intended value from the canonical profile or a permitted saved answer
   before interacting with the control. If a permitted saved value exists, do not ask
   the user for it again merely because browser entry fails.
2. Identify the exact form instance being edited. An embedded application and a
   separately opened fallback page are independent forms; never infer that a value,
   selection, or upload present in one is present in the other.
3. Perform one normal write, then immediately read the control's current state and
   compare it privately with the intended value. Keep this verification value-free in
   logs, progress, history, receipts, and user-facing summaries.
4. If the value did not persist, inspect the control once and make at most one safe
   alternate entry attempt supported by the visible browser, such as sequential
   typing for a text control. Verify the control state again. Do not repeat the same
   action after the bounded fallback fails.
5. Revalidate already-filled critical controls after an upload, selection, navigation,
   or other action that may rerender the form. Restore a cleared value at most once
   using the same bounded loop.
6. If a known value still cannot be entered, classify the blocker as
   `unsupported-control` with `owner-input-required`, leave the visible form open,
   save only value-free progress, and hand control to the user. This is a browser
   handoff, not a missing-answer request. Never claim the field is complete merely
   because the browser operation returned no error.

Record and describe this outcome as **Browser action required**. Tell the user that
the saved information is already known and that the visible browser control needs
their action; do not direct them to add, edit, or repeat the answer in Companion.

An alternate entry method within the same form instance, application attempt,
destination, and already-approved purpose does not require renewed fill consent.
Opening or switching to another form instance is a new action surface and requires
fresh consent before entering private data there. Keep every final action untouched
throughout recovery.

---
