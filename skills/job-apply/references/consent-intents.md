# Reusable consent intents

Use this reference when an application asks for consent or acknowledgment. The
saved answer describes the owner's decision, not a checkbox state or a phrase to
type. A question's control may be a checkbox, radio group, dropdown, or text
field; the same intent can be expressed through any of them.

## Remember the decision

Use the canonical Answer Memory Store. Mark a reviewed reusable consent answer
with `consentIntent` containing a `kind` (`opt_in`, `acknowledgment`, or
`agreement`) and a stable `purpose` ID. The marker classifies the answer; it
does not authorize browser action. Consent defaults appear in the Companion
Answers area. Give each distinct purpose a field class
such as `demographic_consent`; do not use one general "agree to everything"
answer. A generic scope `{}` permits consideration across employers when the
owner explicitly chooses that scope. Use a narrower scope for a provider-specific
decision. The canonical question may describe the purpose in ordinary language;
aliases can record common phrasings. Exact wording and control type are not the
answer's identity. Store a sensitive value only with field-specific permission to
remember it; a remembered decision does not authorize a future consent action.
Consent defaults use `state: "sensitive"` and `sensitivity: "high"`. For an
already-sensitive answer with a remember marker, a metadata-only classification
preserves the saved value and marker.
For example, a recruiting-text-message opt-in belongs to its own `sms_consent`
answer. If the owner has not chosen whether to opt in, observe a missing question
and ask for the decision before storing a value. Do not translate a prior privacy
acknowledgment or demographic-data consent into permission for recruiting texts.

## Match the live request

Read the visible prompt and relevant surrounding notice before using an answer.
Compare the purpose, data or rights involved, recipient, and consequence with the
saved intent. For a known purpose and kind, call `store answer-consent-candidates
--input <private-json>` with `consentIntent` and the observed employer scope.
It returns value-free exact-scope and explicitly general-scope suggestions.
A pending employer observation is not a saved decision. For an unmarked older
answer, use `task semantic-lookup` with the observed wording, field class,
sensitivity, and exact saved scope. Neither lookup grants authority: reject a
candidate if the live meaning differs. For a clearly matching intent whose
wording is lexically distant, read the canonical answer by its known question
and scope, then show the proposed match to the owner in the live-form approval.
Do not turn an uncertain matcher result into automatic authority. A
new purpose, broader use or sharing, missing notice, conflicting option, or
unclear assent requires a new owner decision.

For existing unmarked answers, `store answer-consent-audit` produces a read-only,
value-free classification preview. Review each suggestion with the owner. If
the answer is already sensitive with high sensitivity and a remember marker,
classify it through an exact-revision metadata edit in Answer Memory. An
audit suggestion marked `requiresRetentionConsent` needs `state: "sensitive"` and
`sensitivity: "high"`; obtain explicit field-specific permission to retain its
value and pass `--remember-sensitive` with the exact-revision update. Keep the
saved value unchanged unless the owner corrects it. Do not infer consent from
every `agreement` field class.

## Approve and express it

Once the form and destination are visible, bundle the proposed consent actions
with other current-use sensitive answers into one action-time request. Identify
the destination, each consent purpose, and the action the agent would take. For
an agreement or data-processing consent with legal effect, require confirmation
at action time even when the choice was saved or previously approved. A response
to that request authorizes only the listed controls in this form instance; it
does not authorize a changed notice, another employer, or final submission.
If an application-level approval was given after this exact notice was visible
and explicitly included this consent action, honor it without another prompt.
Do not infer agreement from an application-level instruction to fill saved
questions. If a page calls consent voluntary but validation requires its sole
affirmative checkbox, preserve the draft and report that conflict; do not check
the box merely to advance.

When a saved decline applies and the site visibly rejects the unchecked
control, hand off with the closed `site-required-opt-in-conflict` owner-review
blocker and a `consent_choice` checklist item. Do not leave the saved decline
as a missing answer; the blocker describes a site constraint, not missing
applicant information. The Companion then presents a site consent conflict.

After approval, map the saved decision to the visible control:

| Control | Expression of an affirmative decision |
| --- | --- |
| Checkbox | Check the consent box. |
| Radio group or dropdown | Select the option that clearly means agreement. |
| Text field | Enter the assent phrase the form explicitly requests, such as `I agree`. |

Use the corresponding declining option for a saved decline when the form offers
one. Do not infer that an empty required box means decline. A typed name,
signature, unexplained free-form statement, or ambiguous option requires owner
action or a separate exact approval. Read the control again after acting and
verify the selected state or entered phrase. If the control does not persist,
follow the bounded browser recovery in [browser.md](browser.md); preserve the
draft and hand off an unsupported control if needed.

Keep only opaque answer references and value-free control status in session and
readiness packets. Consent action approval never authorizes Submit, Send, Apply,
or any equivalent final action.
