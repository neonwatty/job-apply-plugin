// Browser bridge to checked-in TypeScript emissions. Original helpers remain the reference oracle.
export {
  answerNeedsFreshConsent,
  answerSummary,
  canRevealAnswer,
  canRefreshAnswerDraft,
  canApplyAnswerReveal,
  canApplyAnswerDialogResponse,
  canApplyAnswerDialogMutation,
  answerApiPath,
  sameAnswerScope,
} from "../../runtime/workspace-ui/lib/answer-view.js";
export {
  formPatch,
  pointerValue,
  patchForPaths,
  conflictingPaths,
  summarizeProvenance,
  tagsFromInput,
} from "../../runtime/workspace-ui/lib/profile-view.js";
export {
  resumeAssignmentText,
  extractionRequestView,
  proposalGroupForPath,
  shouldUseResumeResponse,
} from "../../runtime/workspace-ui/lib/resume-view.js";
export {
  typedDeletePhrase,
  filterTrashItems,
  trashBlockerText,
  lifecycleErrorText,
} from "../../runtime/workspace-ui/lib/trash-view.js";
export {
  filterJobs,
  transitionsFor,
  canMarkReadyFrom,
  shouldUseActivityResponse,
  newestCanonicalJob,
  activitySignature,
  activityAnnouncement,
  attentionMembershipSignature,
  attentionAnnouncement,
  attentionMissingInformationText,
  attentionBlockerSummary,
  ownerBetaNextStep,
} from "../../runtime/workspace-ui/lib/activity-view.js";
export { fileToBase64 } from "./helpers-original.js";
