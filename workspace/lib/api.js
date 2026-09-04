export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `Workspace request failed (${status})`);
    this.status = status;
    this.code = payload?.error?.code || "request_error";
    this.recordType = payload?.error?.recordType || null;
    this.operation = payload?.error?.operation || null;
    this.counts = payload?.error?.counts || {};
  }
}

export const FACT_SAVE_REVISION_RETRIES = 2;

export function shouldRetryFactSave(error, retries, maxRetries = FACT_SAVE_REVISION_RETRIES) {
  return error instanceof ApiError
    && error.status === 409
    && error.code === "revision_conflict"
    && retries < maxRetries;
}

export function tokenFromHash(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  return params.get("token") || "";
}

export function sessionToken(hash, storage) {
  const token = tokenFromHash(hash);
  try {
    if (token) storage?.setItem("jobApplyWorkspaceToken", token);
    return token || storage?.getItem("jobApplyWorkspaceToken") || "";
  } catch {
    return token;
  }
}

export function safeSessionStorage(scope) {
  try { return scope?.sessionStorage || null; } catch { return null; }
}

export function createApi(token, fetchImpl = globalThis.fetch) {
  return async function api(path, options = {}) {
    const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(path, { ...options, headers });
    let payload = null;
    try { payload = await response.json(); } catch { /* handled below */ }
    if (!response.ok) throw new ApiError(response.status, payload);
    return payload;
  };
}

export function createLatestRequestCoordinator() {
  let latestRequest = 0;
  return {
    invalidate() { latestRequest += 1; },
    async run(load, onSuccess, onFailure) {
      const requestId = ++latestRequest;
      try {
        const value = await load();
        if (requestId !== latestRequest) return false;
        onSuccess(value);
      } catch (error) {
        if (requestId !== latestRequest) return false;
        onFailure(error);
      }
      return true;
    },
  };
}

export function employerAccountOverrideRequest(account, email, clear = false) {
  if (!account || typeof account.realmRef !== "string" || !Number.isInteger(account.revision) || account.revision < 1) {
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
  if (!status || typeof status.jobId !== "string" || !Number.isInteger(status.approvalRevision) || status.approvalRevision < 1) {
    throw new TypeError("A canonical Trusted Fill approval revision is required");
  }
  return {
    path: `/api/trusted-fill/${encodeURIComponent(status.jobId)}/revoke`,
    options: { method: "POST", body: JSON.stringify({ expectedApprovalRevision: status.approvalRevision }) },
  };
}
