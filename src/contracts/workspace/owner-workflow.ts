/** Immutable scope of one explicitly opted-in broker process, never a browser grant. */
export interface OwnerWorkflowScope {
  jobId: string;
  jobRevision: string;
  inputRevision: string;
  taskId: string | null;
  taskRevision: string | null;
}

/** Value-free identity for the selected managed resume in an owner review inventory. */
export const ownerResumeControlId = 'resume.file';
