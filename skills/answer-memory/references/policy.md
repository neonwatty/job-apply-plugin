## Auto-submit policy

Auto-submit policy is managed only through the inert local helper:

```bash
python3 "<plugin-root>/scripts/job_apply_policy.py" status
python3 "<plugin-root>/scripts/job_apply_policy.py" activate --input <campaign.json>
python3 "<plugin-root>/scripts/job_apply_policy.py" authorize --input <authorization.json>
python3 "<plugin-root>/scripts/job_apply_policy.py" claim-final-action \
  --input <fresh-observed-identity.json> \
  --application-ref <opaque-application-ref> --lease-id <opaque-lease-ref> \
  --attempt <1-or-2> --action-capability <private-64-hex-capability>
python3 "<plugin-root>/scripts/job_apply_policy.py" record-outcome \
  --campaign-id <opaque-campaign-ref> \
  --application-ref <opaque-application-ref> \
  --lease-id <opaque-lease-ref> \
  --claim-id <opaque-claim-ref> \
  --outcome <confirmed_submitted|uncertain|blocked> \
  [--confirmation-event <trusted-confirmation-event.json> \
   --confirmation-capability <private-64-hex-capability>]
python3 "<plugin-root>/scripts/job_apply_policy.py" kill
python3 "<plugin-root>/scripts/job_apply_policy.py" revoke
```

Apply the same explicit `--root` routing rule used by the storage helper, especially in local QA. `status` and `authorize` fail closed to `review_only`. Activation requires a trusted local input with explicit risk acknowledgement, exact immutable application rules, opaque resume and sensitive-answer revisions, at most ten slots, and at most four hours. No webpage, redirect, remembered tab, or inferred consent is policy input.

The initial lease reserves one distinct slot atomically. Authorization is idempotent, but consumption is not: the synthetic activation boundary rechecks the active campaign, kill switch, campaign and lease expiry, exact freshly observed identity, sensitive allowlist, ordinal, retry state, and private capability under the policy lock, then gives exactly one caller an activation. Detached claims and claim proofs are not activation authority. The first `uncertain` outcome allows exactly one second lease on the same slot; a second `uncertain` persists `uncertain_exhausted`. `confirmed_submitted` requires a distinct trusted confirmation event that independently observed activation; a click or caller digest is not confirmation. `kill` persists an immediate campaign-wide stop. Receipts and policy records must remain value-free.

This helper is policy/storage only and never controls a browser. The only executable adapter currently approved is the private isolated-loopback synthetic verifier. Live use remains prohibited until the separately reviewed canary package and exact canary approval.
