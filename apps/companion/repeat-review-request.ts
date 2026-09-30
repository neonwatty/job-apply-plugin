export function repeatReviewRequest(jobId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId) || jobId.includes('..')) throw Error('Invalid job id');
  return `Use the Job Apply workflow to repeat a review-only dogfood run for saved job ${jobId} from a fresh blank application. First ask me to confirm the previous application was not submitted, then inspect its current Store revision and use the supported restart-review flow. Use the selected managed resume and current saved answers only after the required fresh approvals for this exact form, including sensitive answers and consent actions. Verify the current live form, hand off at awaiting_review, and leave the final Submit action untouched.`;
}
