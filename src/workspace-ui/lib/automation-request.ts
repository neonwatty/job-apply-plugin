/** Inert request construction; callers retain all IO and approval authority. */
interface AccountInput { realmRef: string; revision: number }
interface RevokeInput { jobId: string; approvalRevision: number }
interface ApprovalInput {
  jobId: unknown;
  expectedJobRevision: unknown;
  realmRef: unknown;
  answerRefs: unknown;
  observedQuestionFingerprint: unknown;
  observedControlFingerprint: unknown;
  formFingerprint: unknown;
  allowedOperations: Iterable<unknown> | undefined;
  durationMinutes: unknown;
}
interface Request<M extends string> { path: string; options: { method: M; body: string } }
export interface TrustedFillApprovalPacket {
  jobId: string;
  expectedJobRevision: number;
  realmRef: string;
  answerRefs: string[];
  observedQuestionFingerprint: string;
  observedControlFingerprint: string;
  formFingerprint: string;
  allowedOperations: unknown[];
  durationMinutes: number;
}

// Assertions expose property access to the compiler without validating, caching,
// or changing the original JavaScript's repeated reads and coercion order.
export function employerAccountOverrideRequest(account: unknown, email: unknown, clear: unknown = false): Request<"PATCH"> {
  if (!account || typeof (account as AccountInput).realmRef !== "string"
    || !Number.isInteger((account as AccountInput).revision) || (account as AccountInput).revision < 1) {
    throw new TypeError("A canonical employer account revision is required");
  }
  return {
    path: `/api/employer-accounts/${encodeURIComponent((account as AccountInput).realmRef)}`,
    options: {
      method: "PATCH",
      body: JSON.stringify({
        patch: { signupEmailOverride: clear ? null : String(email || "").trim() },
        expectedRevision: (account as AccountInput).revision,
      }),
    },
  };
}

export function trustedFillApprovalPacket(values: unknown): TrustedFillApprovalPacket {
  return {
    jobId: String((values as ApprovalInput).jobId || "").trim(),
    expectedJobRevision: Number((values as ApprovalInput).expectedJobRevision),
    realmRef: String((values as ApprovalInput).realmRef || "").trim(),
    answerRefs: String((values as ApprovalInput).answerRefs || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    observedQuestionFingerprint: String((values as ApprovalInput).observedQuestionFingerprint || "").trim(),
    observedControlFingerprint: String((values as ApprovalInput).observedControlFingerprint || "").trim(),
    formFingerprint: String((values as ApprovalInput).formFingerprint || "").trim(),
    allowedOperations: [...((values as ApprovalInput).allowedOperations || [])].sort(),
    durationMinutes: Number((values as ApprovalInput).durationMinutes),
  };
}

export function trustedFillRevokeRequest(status: unknown): Request<"POST"> {
  if (!status || typeof (status as RevokeInput).jobId !== "string"
    || !Number.isInteger((status as RevokeInput).approvalRevision) || (status as RevokeInput).approvalRevision < 1) {
    throw new TypeError("A canonical Trusted Fill approval revision is required");
  }
  return {
    path: `/api/trusted-fill/${encodeURIComponent((status as RevokeInput).jobId)}/revoke`,
    options: { method: "POST", body: JSON.stringify({ expectedApprovalRevision: (status as RevokeInput).approvalRevision }) },
  };
}
