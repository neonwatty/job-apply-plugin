// These structural views retain the existing helpers' JavaScript property access
// and coercion behavior. They do not validate or normalize incoming projections.
export function resumeAssignmentText(resume) {
    const record = resume;
    const explicit = Number.isInteger(record?.assignedJobCount) ? record.assignedJobCount : 0;
    const implicit = Number.isInteger(record?.implicitJobCount) ? record.implicitJobCount : 0;
    return `${explicit} explicitly assigned active job${explicit === 1 ? "" : "s"}${implicit ? `; ${implicit} active job${implicit === 1 ? "" : "s"} use this default` : ""}.`;
}
export function extractionRequestView(request, proposalSummary) {
    const record = request;
    const proposal = proposalSummary;
    if (!request || record.status === "cancelled") {
        return { label: "Facts not extracted", action: "request", tone: "neutral" };
    }
    if (record.status === "requested") {
        return { label: "Waiting for a Job Apply agent", action: "cancel", tone: "waiting" };
    }
    if (record.status === "failed") {
        return { label: "Fact extraction did not complete", action: "retry", tone: "warning" };
    }
    if (record.status === "stale") {
        return { label: "The resume changed after this request", action: "fresh", tone: "warning" };
    }
    if (record.status === "completed" && proposal?.status === "pending" && proposal.staleReasons?.length) {
        return { label: "Extraction review is no longer current", action: "fresh", tone: "warning" };
    }
    if (record.status === "completed" && proposal?.status === "pending") {
        return { label: "Extracted changes need review", action: "review", tone: "review" };
    }
    return { label: "Extracted facts were applied or reviewed", action: "facts", tone: "complete" };
}
export function proposalGroupForPath(path) {
    const top = String(path || "").split("/")[1] || "";
    if (["firstName", "lastName"].includes(top))
        return "Identity";
    if (["email", "phone"].includes(top))
        return "Contact";
    if (top === "location")
        return "Location";
    if (top === "workHistory")
        return "Experience";
    if (top === "education")
        return "Education";
    if (top === "skills")
        return "Skills";
    if (["linkedInUrl", "portfolioUrl", "githubUrl"].includes(top))
        return "Links";
    return "Additional";
}
export function shouldUseResumeResponse(requestId, latestRequestId, requestedTrash, currentTrash) {
    return requestId === latestRequestId && requestedTrash === currentTrash;
}
