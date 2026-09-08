// Assertions expose property access to the compiler without validating, caching,
// or changing the original JavaScript's repeated reads and coercion order.
export function employerAccountOverrideRequest(account, email, clear = false) {
    if (!account || typeof account.realmRef !== "string"
        || !Number.isInteger(account.revision) || account.revision < 1) {
        throw new TypeError("A canonical employer account revision is required");
    }
    return {
        path: `/api/employer-accounts/${encodeURIComponent(account.realmRef)}`,
        options: {
            method: "PATCH",
            body: JSON.stringify({
                patch: { signupEmailOverride: clear ? null : String(email || "").trim() },
                expectedRevision: account.revision,
            }),
        },
    };
}
export function trustedFillApprovalPacket(values) {
    return {
        jobId: String(values.jobId || "").trim(),
        expectedJobRevision: Number(values.expectedJobRevision),
        realmRef: String(values.realmRef || "").trim(),
        answerRefs: String(values.answerRefs || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        observedQuestionFingerprint: String(values.observedQuestionFingerprint || "").trim(),
        observedControlFingerprint: String(values.observedControlFingerprint || "").trim(),
        formFingerprint: String(values.formFingerprint || "").trim(),
        allowedOperations: [...(values.allowedOperations || [])].sort(),
        durationMinutes: Number(values.durationMinutes),
    };
}
export function trustedFillRevokeRequest(status) {
    if (!status || typeof status.jobId !== "string"
        || !Number.isInteger(status.approvalRevision) || status.approvalRevision < 1) {
        throw new TypeError("A canonical Trusted Fill approval revision is required");
    }
    return {
        path: `/api/trusted-fill/${encodeURIComponent(status.jobId)}/revoke`,
        options: { method: "POST", body: JSON.stringify({ expectedApprovalRevision: status.approvalRevision }) },
    };
}
