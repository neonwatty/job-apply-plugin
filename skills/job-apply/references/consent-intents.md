# Reusable consent intents

Use this reference when an application asks for consent or acknowledgment. The
saved answer describes the owner's decision, not a checkbox state or a phrase to
type. A question's control may be a checkbox, radio group, dropdown, or text
field; the same intent can be expressed through any of them.

## Remember the decision

Use the canonical Answer Memory Store. Give each distinct purpose a field class
such as `demographic_consent`; do not use one general "agree to everything"
answer. A generic scope `{}` permits consideration across employers when the
owner explicitly chooses that scope. Use a narrower scope for a provider-specific
decision. The canonical question may describe the purpose in ordinary language;
aliases can record common phrasings. Exact wording and control type are not the
answer's identity. Store a sensitive value only with field-specific permission to
remember it; a remembered decision does not authorize a future consent action.

## Match the live request

Read the visible prompt and relevant surrounding notice before using an answer.
Compare the purpose, data or rights involved, recipient, and consequence with the
saved intent. Use `task semantic-lookup` with the observed wording, semantic field
class, sensitivity, and the chosen scope. An exact or high candidate is still only
a candidate: reject it if the live meaning differs. For a clearly matching intent
whose wording is lexically distant, read the canonical answer by its known
question and scope, then show the proposed match to the owner in the live-form
approval. Do not turn an uncertain matcher result into automatic authority. A
new purpose, broader use or sharing, missing notice, conflicting option, or
unclear assent requires a new owner decision.

## Approve and express it

Once the form and destination are visible, bundle the proposed consent actions
with other current-use sensitive answers into one action-time request. Identify
the destination, each consent purpose, and the action the agent would take. For
an agreement or data-processing consent with legal effect, require confirmation
at action time even when the choice was saved or previously approved. A response
to that request authorizes only the listed controls in this form instance; it
does not authorize a changed notice, another employer, or final submission.

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
