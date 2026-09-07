export function filterJobs(jobs, query = "", status = "") {
    const needle = query.trim().toLocaleLowerCase();
    return jobs.filter((job) => {
        if (status && job.status !== status)
            return false;
        if (!needle)
            return true;
        return [job.role, job.company, job.location, job.url]
            .some((value) => String(value || "").toLocaleLowerCase().includes(needle));
    });
}
export function transitionsFor(status) {
    return {
        saved: ["needs_info", "closed"], needs_info: ["saved", "closed"], ready: ["saved", "needs_info", "closed"],
        in_progress: [], awaiting_review: ["applied", "closed"],
        applied: ["closed"], closed: ["saved"],
    }[status] || [];
}
export function canMarkReadyFrom(status) {
    return status === "saved" || status === "needs_info";
}
export function shouldUseActivityResponse(activity, ...knownJobs) {
    const responseJob = activity?.job;
    if (!Number.isInteger(responseJob?.revision))
        return false;
    const knownRevision = Math.max(0, ...knownJobs
        .filter((job) => Number.isInteger(job?.revision))
        .map((job) => job.revision));
    return responseJob.revision >= knownRevision;
}
export function newestCanonicalJob(current, incoming) {
    if (!current)
        return incoming;
    if (!incoming || current.id !== incoming.id)
        return current;
    const currentRevision = Number.isInteger(current.revision) ? current.revision : 0;
    const incomingRevision = Number.isInteger(incoming.revision) ? incoming.revision : 0;
    return incomingRevision >= currentRevision ? incoming : current;
}
export function activitySignature(activity) {
    if (!activity)
        return "";
    return JSON.stringify({
        status: activity.job?.status,
        revision: activity.job?.revision,
        sessionStatus: activity.session?.status,
        sessionStep: activity.session?.step,
        sessionUpdatedAt: activity.session?.updatedAt,
        pendingInformation: activity.session?.pendingInformation || [],
        claimState: activity.claim?.state,
        claimHeartbeatAt: activity.claim?.heartbeatAt,
        history: activity.history || [],
    });
}
export function activityAnnouncement(previous, current) {
    if (!previous || activitySignature(previous) === activitySignature(current))
        return "";
    const changes = [];
    if (previous.job?.status !== current.job?.status)
        changes.push(`Status changed to ${String(current.job?.status || "saved").replaceAll("_", " ")}.`);
    if (previous.claim?.state !== current.claim?.state)
        changes.push(`Agent attempt is ${current.claim?.state || "not active"}.`);
    if (previous.session?.updatedAt !== current.session?.updatedAt && current.session?.step)
        changes.push(`Progress updated at ${current.session.step}.`);
    if ((previous.history || []).length !== (current.history || []).length)
        changes.push("Application history updated.");
    return changes.join(" ");
}
export function attentionMembershipSignature(projection) {
    return JSON.stringify((projection?.items || []).map((item) => [item.jobId, item.reasonCode]));
}
export function attentionAnnouncement(previous, current) {
    if (!previous || attentionMembershipSignature(previous) === attentionMembershipSignature(current))
        return "";
    const count = current?.items?.length || 0;
    return `Needs Attention queue updated. ${count} job${count === 1 ? "" : "s"} now require action.`;
}
export function attentionMissingInformationText(item) {
    if (item?.reasonCode !== "needs_information")
        return "";
    const count = Number.isInteger(item.missingInformationCount) ? item.missingInformationCount : 0;
    return ` · ${count} missing information item${count === 1 ? "" : "s"}`;
}
export function attentionBlockerSummary(item) {
    const blockers = item?.session?.blockers || [];
    const knownDataBrowserFailure = item?.reasonCode === "browser_action_required"
        && blockers.length === 2
        && blockers.some((entry) => entry.type === "browser_handoff" && entry.code === "unsupported-control")
        && blockers.some((entry) => entry.type === "information" && entry.code === "owner-input-required");
    if (knownDataBrowserFailure) {
        return "Browser action required: unsupported control. Saved information is already known.";
    }
    return blockers.length
        ? `${blockers.length} typed blocker${blockers.length === 1 ? "" : "s"}: ${blockers.map((entry) => entry.code).join(", ")}`
        : "No typed blockers recorded.";
}
export function ownerBetaNextStep(action) {
    return {
        import_resume: ["Import a resume", "Add a private managed resume so agents have an approved document to use."],
        review_facts: ["Review your application facts", "Confirm the local facts agents may use before you prepare a job."],
        resolve_attention: ["Resolve Needs Attention", "A job needs human review, missing information, or interrupted-work recovery."],
        handoff_ready_job: ["Hand off a ready job", "Copy the supported invocation below and let the agent acquire the canonical Ready job."],
        capture_job: ["Capture your first job", "Save an opportunity, run its ready check, and mark it Ready for an agent."],
        prepare_job: ["Prepare the next job", "Open Jobs, complete missing setup, run the ready check, and mark a job Ready."],
    }[action] || ["Review the workspace", "Refresh the canonical Store and choose a workspace section."];
}
