import * as helpers from "../lib/helpers.js";

export function installOverview(context) {
  const { api, state: stores, dom, coordinators } = context;
  const {
    job: state,
    overview: overviewState,
    copyInvocationSequences,
  } = stores;
  const {
    $,
    dialog,
    toast,
    setConnection,
  } = dom;
  const {
    overviewRefreshCoordinator,
  } = coordinators;
  const {
    ownerBetaNextStep,
  } = helpers;
  const refresh = (...args) => coordinators.refresh(...args);
  const preflight = (...args) => coordinators.preflight(...args);
  const ensureWorkspacePolling = (...args) => coordinators.ensureWorkspacePolling(...args);
  function freshestKnownJob(jobId) {
    if (!jobId) return null;
    const listed = state.jobs.find((job) => job.id === jobId);
    if (state.activeJobsLoaded && !listed) return null;
    const candidates = [
      listed,
      state.selected?.id === jobId ? state.selected : null,
      state.latest?.id === jobId ? state.latest : null,
      state.activityJobId === jobId ? state.activity?.job : null,
    ].filter((job) => job && Number.isInteger(job.revision));
    if (!candidates.length) return null;
    const revision = Math.max(...candidates.map((job) => job.revision));
    const statuses = new Set(candidates.filter((job) => job.revision === revision).map((job) => job.status));
    return { id: jobId, revision, status: statuses.size === 1 ? [...statuses][0] : null };
  }

  function syncReadyHandoff() {
    const selectedId = state.selected?.id;
    const authoritativelyAbsent = Boolean(
      dialog.open
      && selectedId
      && state.activeJobsLoaded
      && !state.jobs.some((job) => job.id === selectedId),
    );
    if (authoritativelyAbsent) state.readyHandoffProof = null;
    const current = dialog.open ? freshestKnownJob(selectedId) : null;
    const proof = state.readyHandoffProof;
    const visible = Boolean(
      proof
      && state.canonicalStateCurrent
      && current
      && proof.id === current.id
      && proof.revision === current.revision
      && proof.dialogGeneration === state.jobDialogGeneration
      && proof.refreshEpoch === state.refreshEpoch
      && proof.dependencyObservation === state.dependencyObservation
      && current.status === "ready",
    );
    $("#ready-handoff").classList.toggle("hidden", !visible);
  }

  function clearPreflightReadiness({ hidePanel = true } = {}) {
    state.readyHandoffProof = null;
    $("#mark-ready").classList.add("hidden");
    $("#ready-handoff").classList.add("hidden");
    if (hidePanel) {
      $("#preflight-panel").classList.add("hidden");
      $("#preflight-results").replaceChildren();
    }
  }

  function renderOverview(projection) {
    overviewState.projection = projection; overviewState.available = true;
    const [heading, copy] = ownerBetaNextStep(projection.nextAction);
    $("#next-step-heading").textContent = heading;
    $("#next-step-copy").textContent = copy;
    $("#next-step-action").dataset.workspace = projection.targetWorkspace;
    $("#setup-resume").textContent = `${projection.setup.hasResume ? "✓" : "○"} Resume ${projection.setup.hasResume ? "available" : "needed"}`;
    $("#setup-facts").textContent = `${projection.setup.hasProfileFacts ? "✓" : "○"} Application facts ${projection.setup.hasProfileFacts ? "available" : "need review"}`;
    $("#setup-resume").classList.toggle("complete", projection.setup.hasResume);
    $("#setup-facts").classList.toggle("complete", projection.setup.hasProfileFacts);
    const counts = projection.counts;
    $("#overview-counts").textContent = `${counts.jobs} jobs · ${counts.readyJobs} ready · ${counts.attentionJobs} need attention · ${counts.resumes} resumes · ${counts.answers} reviewed answers`;
    $("#overview-ready").classList.remove("hidden");
  }

  async function refreshOverview({ quiet = false } = {}) {
    if (overviewState.degraded) return;
    return overviewRefreshCoordinator.run(
      () => api("/api/overview"),
      (projection) => {
        const recovered = overviewState.unavailable;
        overviewState.unavailable = false;
        $("#overview-unavailable").classList.add("hidden");
        renderOverview(projection); setConnection(true);
        ensureWorkspacePolling();
        if (recovered) $("#overview-live").textContent = "Overview is available again.";
        if (!quiet) toast("Overview refreshed from the canonical store");
      },
      () => {
        overviewState.unavailable = true; overviewState.available = false;
        $("#overview-ready").classList.add("hidden");
        $("#overview-unavailable").classList.remove("hidden");
        setConnection(false, "Overview unavailable — refresh to retry");
        $("#overview-live").textContent = "Overview is unavailable. Next-step guidance is hidden until refresh succeeds.";
      },
    );
  }

  function renderDegradedBoot(boot) {
    overviewState.degraded = true;
    $("#overview-ready").classList.add("hidden");
    $("#boot-recovery-summary").textContent = boot.summary;
    $("#boot-recovery-guidance").textContent = boot.guidance;
    $("#boot-recovery").classList.remove("hidden");
    $("#boot-recovery").focus();
    for (const button of document.querySelectorAll(".workspace-nav button:not(#nav-overview)")) button.disabled = true;
    $("#overview-refresh").disabled = true;
    setConnection(false, "Canonical store unavailable — recovery guidance shown");
  }

  async function copyInvocation(button) {
    const surface = button.closest(".handoff-card");
    const sequence = (copyInvocationSequences.get(surface) || 0) + 1;
    copyInvocationSequences.set(surface, sequence);
    const fallback = surface?.querySelector(".clipboard-fallback");
    const fallbackValue = fallback?.querySelector(".clipboard-fallback-value");
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      if (copyInvocationSequences.get(surface) !== sequence) return;
      fallback?.classList.add("hidden");
      toast(`${button.textContent.replace(/^Copy /, "")} copied`);
    } catch {
      if (copyInvocationSequences.get(surface) !== sequence) return;
      if (fallback && fallbackValue) {
        fallbackValue.value = button.dataset.copy;
        fallback.classList.remove("hidden");
        fallbackValue.focus(); fallbackValue.select();
      }
      $("#overview-live").textContent = "Clipboard unavailable. A selectable invocation is shown in the active handoff surface.";
    }
  }


  Object.assign(coordinators, { freshestKnownJob, syncReadyHandoff, clearPreflightReadiness, renderOverview, refreshOverview, renderDegradedBoot, copyInvocation });
}
