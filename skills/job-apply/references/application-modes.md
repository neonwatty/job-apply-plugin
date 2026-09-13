# Application automation modes

The canonical Store and Companion expose one current, revisioned application authority. A Store without this document migrates to **Guided** when status is first read. The durable authority contains only each approved destination origin—not paths or query strings—and no applicant values, questions, browser state, claim bearer, or final-action capability. Its public status projection omits destinations entirely.

## Modes and approval scope

- **Guided** is the safe default. Keep the existing post-readiness, granular confirmation flow. A missing, revoked, consumed, expired, invalid, or out-of-scope authority is Guided; never infer broader permission from conversation history.
- **Fill to Review** is one approval for one exact Ready/In Progress canonical job and one named worker. It covers canonical non-sensitive profile facts, the selected current managed resume, accepted confirmed non-sensitive reusable answers, one bounded repair of a field cleared by a portal rerender, and clearly non-final navigation on ordinary later pages at the same destination origin. It is consumed only by a successful `awaiting_review` handoff; a Needs Attention handoff leaves it available until expiry or revocation so the same application can resume.
- **Campaign** applies the same review-bound authority to the explicitly selected bounded job IDs and worker IDs until expiry or revocation. Every evaluation still requires the named worker to own the exact live Store claim for the selected job. The Store coordinator remains the concurrency boundary: an authority never bypasses claim exclusivity, revision conflicts, or stale-claim recovery.

Changing mode, jobs, workers, sensitive classes, or duration is a scope change. Save a replacement against the exact current authority revision; stale or concurrent writes fail without retry. Returning to Guided explicitly revokes the current authority. Status in Companion and the broker acquisition response shows the effective mode, state, revision, expiry, selected job IDs, selected workers, and sensitive field classes.

## Evaluation and interrupts

Before each group of browser actions, evaluate the current page and proposed operations through `application-authority-evaluate`. Later pages do not manufacture new consent merely because their question or control fingerprints differ. Continue only while the destination origin, selected job, named live worker claim, canonical managed resume, confirmed answer state, declared operations, and unexpired authority remain covered.

Interrupt for missing or uncertain data, CAPTCHA, MFA, email verification, provider legal consent, unsupported controls, an unexpected destination, ambiguity, or any final action. Authentication and account-creation boundaries in [browser.md](browser.md) remain human-only. Submit, Send, Apply, or an equivalent final control is manual in every mode; it is not an allowed operation and `finalAction` always returns `final_action_manual`.

Strict answer matching continues to require explicit `per_use` authority for sensitive answers. Campaign may use `bounded_loose` only when setup names a supported sensitive field class and the evaluation supplies an exact accepted confirmed sensitive answer reference with that same declared class. A field class is never inferred. This is current-use permission only: it does not set, replace, or imply `rememberedWithConsentAt`, and `--remember-sensitive` still requires separate fresh field-specific consent.

Legacy exact-form Grounded Trusted Fill approvals remain readable and revocable for compatibility, but they do not grant these modes. The legacy auto-submit policy store is an isolated internal compatibility surface and must not be used by ordinary Guided, Fill to Review, or Campaign workers.
