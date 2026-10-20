import { createLatestRequestCoordinator } from "./api.js";

export function createWorkspaceState() {
  const state = {
    jobs: [], activeJobsLoaded: false, resumes: [], selected: null, latest: null,
    draft: null, dirty: false, dirtyFields: new Set(), refreshPromise: null,
    refreshEpoch: 0, canonicalStateCurrent: false, pollIntervalId: null,
    opener: null, openerJobId: null, focusAfterClose: null,
    focusAfterCloseJobId: null, activity: null, activityJobId: null,
    activityUnavailable: false, attentionReturnJobId: null,
    navigationGeneration: 0, jobDialogGeneration: 0, dependencyObservation: 0,
    preflightRequestSequence: 0, preflightPolling: false, preflightError: null,
    readyHandoffProof: null, groupedApprovalPreview: null,
    groupedApprovalRequest: null, groupedApprovalProjectionSignature: null,
    groupedApprovalRequestSequence: 0,
  };
  return {
    job: state,
    profile: { inspection: null, preparedness: null, drafts: new Map(), draftBases: new Map(), atomic: new Set(), additionalAtomic: new Set(), deletions: new Set(), conflicts: [], latest: null, loaded: false },
    factGroup: { items: [], selectedView: "all", selected: null, editing: null, loaded: false, opener: null, requestSequence: 0 },
    resume: { items: [], proposals: [], trash: false, loaded: false, loading: false, requestId: 0, selected: null, opener: null, proposal: null, dirtyMetadata: new Set(), pendingReview: null },
    answer: { items: [], loaded: false, selected: null, offset: 0, limit: 25, total: 0, dirty: new Set(), opener: null, pendingJobId: null, pendingReference: null, requestSequence: 0, detailRequestSequence: 0, dialogGeneration: 0, mergeRequestSequence: 0, mergeSource: null, mergeCandidates: [], cleanupPreview: null, busyControls: null },
    trash: { items: [], counts: { job: 0, resume: 0, answer: 0 }, loaded: false, selected: null, opener: null },
    attention: { items: [], snapshotSignature: "", loaded: false, unavailable: false, detailRequestSequence: 0 },
    overview: { projection: null, available: false, degraded: false, unavailable: false },
    automation: { projection: null, loaded: false },
    accountOperation: { status: null },
    trustedFill: { status: null },
    jobCardRenderKeys: new WeakMap(),
    copyInvocationSequences: new WeakMap(),
  };
}

export function createCoordinators() {
  return {
    trashRefreshCoordinator: createLatestRequestCoordinator(),
    activityRefreshCoordinator: createLatestRequestCoordinator(),
    attentionRefreshCoordinator: createLatestRequestCoordinator(),
    overviewRefreshCoordinator: createLatestRequestCoordinator(),
  };
}
