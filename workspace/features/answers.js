import * as helpers from "../lib/helpers.js";

export function installAnswers(context) {
  const { api, state: stores, dom, coordinators } = context;
  const {
    job: state,
    answer: answerState,
  } = stores;
  const {
    $,
    form,
    dialog,
    statusLabel,
    toast,
    setConnection,
  } = dom;
  const {
    answerSummary,
    canRevealAnswer,
    canApplyAnswerDialogResponse,
    canApplyAnswerDialogMutation,
    answerApiPath,
    sameAnswerScope,
    lifecycleErrorText,
  } = helpers;
  const save = (...args) => coordinators.save(...args);
  function answerError(message, dialogError = false) { const node = $(dialogError ? "#answer-error" : "#answers-error"); node.textContent = message; node.classList.remove("hidden"); }

  function setAnswerBusy(busy) {
    if (busy) {
      if (answerState.busyControls) return;
      answerState.busyControls = [...$("#answer-form").elements]
        .filter((control) => !control.matches("[data-close]"))
        .map((control) => [control, control.disabled]);
      for (const [control] of answerState.busyControls) control.disabled = true;
      return;
    }
    for (const [control, disabled] of answerState.busyControls || []) control.disabled = disabled;
    answerState.busyControls = null;
  }

  function renderAnswers() {
    const list = $("#answer-list"); list.replaceChildren();
    $("#answers-empty").classList.toggle("hidden", answerState.items.length !== 0);
    for (const answer of answerState.items) {
      const item = document.createElement("div"); item.setAttribute("role", "listitem");
      const button = document.createElement("button"); button.type = "button"; button.className = "answer-card"; button.dataset.key = answer.key;
      const primary = document.createElement("div"); const heading = document.createElement("h3"); heading.textContent = answer.question || answer.key; const summary = document.createElement("p"); summary.textContent = answerSummary(answer); summary.classList.toggle("redacted", answer.valueRedacted === true); primary.append(heading, summary);
      const metadata = document.createElement("p"); metadata.textContent = `${answer.state} · ${answer.reviewStatus} · revision ${answer.revision}`;
      const references = document.createElement("p"); references.textContent = `${answer.referenceCounts?.total || 0} reference${answer.referenceCounts?.total === 1 ? "" : "s"}`;
      button.append(primary, metadata, references); button.addEventListener("click", () => openAnswer(answer, button)); item.append(button); list.append(item);
    }
    const first = answerState.total === 0 ? 0 : answerState.offset + 1; const last = answerState.offset + answerState.items.length;
    $("#answers-status").textContent = `${answerState.total} canonical record${answerState.total === 1 ? "" : "s"} in this view; showing ${first}–${last}. Values are not included in this list.`;
    $("#answers-previous").disabled = answerState.offset === 0; $("#answers-next").disabled = answerState.offset + answerState.items.length >= answerState.total;
  }

  async function refreshAnswers({ reset = false } = {}) {
    if (reset) answerState.offset = 0;
    $("#answers-error").classList.add("hidden");
    const view = $("#answer-view").value;
    const requestSequence = ++answerState.requestSequence;
    try {
      const result = await api("/api/answers/query", { method: "POST", body: JSON.stringify({ query: $("#answer-search").value, state: $("#answer-state-filter").value || null, reviewStatus: view === "trash" ? null : view, includeTrashed: view === "trash", trashedOnly: view === "trash", offset: answerState.offset, limit: answerState.limit }) });
      if (requestSequence !== answerState.requestSequence) return;
      answerState.items = result.items; answerState.total = result.total; answerState.loaded = true; renderAnswers(); setConnection(true);
    } catch (error) { if (requestSequence !== answerState.requestSequence) return; answerError(error.message); setConnection(false, error.message); }
  }

  function syncSensitiveConsent() {
    const form = $("#answer-form");
    const sensitive = form.elements.state.value === "sensitive" || form.elements.sensitivity.value !== "none";
    $("#remember-sensitive-label").classList.toggle("hidden", !sensitive);
    if (!sensitive) form.elements.rememberSensitive.checked = false;
  }

  function populateAnswerForm(answer) {
    setAnswerBusy(false);
    const form = $("#answer-form");
    form.elements.question.value = answer?.question || ""; form.elements.aliases.value = (answer?.aliases || []).join("\n"); form.elements.state.value = answer?.state || "confirmed"; form.elements.sensitivity.value = answer?.sensitivity || "none"; form.elements.scope.value = JSON.stringify(answer?.scope || {}, null, 2); form.elements.value.value = answer?.value ?? ""; form.elements.rememberSensitive.checked = false; syncSensitiveConsent();
    form.elements.question.required = !answer;
    answerState.dirty.clear(); $("#answer-error").classList.add("hidden"); $("#answer-conflict").classList.add("hidden");
    const pending = answer?.reviewStatus === "pending"; const trashed = answer?.deletedAt != null;
    $("#answer-reveal").classList.toggle("hidden", !canRevealAnswer(answer)); $("#answer-merge").classList.toggle("hidden", !answer || trashed); $("#answer-accept").classList.toggle("hidden", !pending || trashed); $("#answer-decline").classList.toggle("hidden", !pending || trashed); $("#answer-trash").classList.toggle("hidden", !answer || trashed); $("#answer-restore").classList.toggle("hidden", !trashed); $("#answer-delete").classList.toggle("hidden", !trashed); $("#answer-save").classList.toggle("hidden", trashed);
    $("#answer-reference-counts").textContent = answer ? `${answer.referenceCounts?.sessions || 0} session and ${answer.referenceCounts?.history || 0} history references.` : "";
  }

  function showAnswerDetail(selected, opener, pendingJobId = null, pendingReference = null) {
    answerState.dialogGeneration += 1; answerState.opener = opener || document.activeElement;
    answerState.pendingJobId = pendingJobId; answerState.pendingReference = pendingReference; answerState.selected = selected; populateAnswerForm(selected);
    $("#answer-kicker").textContent = `CANONICAL · REVISION ${selected.revision}`; $("#answer-dialog").showModal(); setTimeout(() => $("#answer-form").elements.question.focus(), 0);
  }

  async function openAnswer(answer, opener) {
    const requestSequence = ++answerState.detailRequestSequence;
    const requestedOpener = opener || document.activeElement;
    try {
      const selected = await api(answerApiPath(answer.key));
      if (requestSequence !== answerState.detailRequestSequence) return;
      showAnswerDetail(selected, requestedOpener);
    } catch (error) { if (requestSequence === answerState.detailRequestSequence) answerError(error.message); }
  }
  function newAnswer() { answerState.detailRequestSequence += 1; answerState.dialogGeneration += 1; answerState.selected = null; answerState.opener = document.activeElement; answerState.pendingJobId = null; answerState.pendingReference = null; populateAnswerForm(null); $("#answer-kicker").textContent = "NEW CANONICAL RECORD"; $("#answer-dialog").showModal(); setTimeout(() => $("#answer-form").elements.question.focus(), 0); }

  function answerFormPayload(onlyDirty = false) {
    const form = $("#answer-form"); let scope; try { scope = JSON.parse(form.elements.scope.value); } catch { throw new Error("Scope must be a valid JSON object."); } if (!scope || Array.isArray(scope) || typeof scope !== "object") throw new Error("Scope must be a JSON object.");
    const all = { question: form.elements.question.value, aliases: form.elements.aliases.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), state: form.elements.state.value, sensitivity: form.elements.sensitivity.value, scope, value: form.elements.state.value === "missing" ? null : form.elements.value.value, source: "user" };
    if (!onlyDirty) return all;
    const patch = {}; for (const name of answerState.dirty) if (Object.hasOwn(all, name)) patch[name] = all[name]; return patch;
  }

  async function saveAnswer(event) {
    event.preventDefault();
    const selected = answerState.selected;
    const requestedKey = selected?.key ?? null;
    const dialogGeneration = answerState.dialogGeneration;
    try {
      const answer = answerFormPayload(Boolean(selected));
      if (selected && !Object.keys(answer).length) throw new Error("Change at least one field before saving.");
      const rememberSensitive = $("#answer-form").elements.rememberSensitive.checked;
      setAnswerBusy(true);
      const result = selected
        ? await api(answerApiPath(selected.key), { method: "PATCH", body: JSON.stringify({ patch: answer, expectedRevision: selected.revision, rememberSensitive }) })
        : await api("/api/answers", { method: "POST", body: JSON.stringify({ answer, rememberSensitive }) });
      const currentDialog = canApplyAnswerDialogMutation(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open);
      const pendingReturn = Boolean(answerState.pendingJobId && dialog.open);
      if (currentDialog) { if (!pendingReturn) answerState.opener = null; $("#answer-dialog").close(); }
      await refreshAnswers({ reset: true });
      if (currentDialog && !pendingReturn) (document.querySelector(`.answer-card[data-key="${CSS.escape(result.key)}"]`) || $("#answer-new")).focus();
      toast(`Answer ${selected ? "updated" : "created"}`); return result;
    } catch (error) { if (!canApplyAnswerDialogMutation(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) { toast(error.message); return; } if (error.status === 409) { $("#answer-conflict").classList.remove("hidden"); $("#answer-conflict").focus(); } else answerError(error.message, true); }
    finally { if (canApplyAnswerDialogMutation(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) setAnswerBusy(false); }
  }

  async function answerAction(action) {
    const answer = answerState.selected; if (!answer) return;
    const dialogGeneration = answerState.dialogGeneration;
    setAnswerBusy(true);
    try {
      const payload = { expectedRevision: answer.revision };
      if (action === "accept") { payload.patch = answerFormPayload(true); payload.rememberSensitive = $("#answer-form").elements.rememberSensitive.checked; }
      await api(answerApiPath(answer.key, action), { method: "POST", body: JSON.stringify(payload) });
      const currentDialog = canApplyAnswerDialogMutation(answerState.selected, answer.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open);
      const pendingReturn = Boolean(answerState.pendingJobId && dialog.open);
      if (currentDialog) { if (!pendingReturn) answerState.opener = null; $("#answer-dialog").close(); }
      await refreshAnswers({ reset: true }); if (currentDialog && !pendingReturn) $("#answer-new").focus(); toast(`Answer ${action === "accept" ? "accepted" : action === "decline" ? "declined" : `${action}d`}`);
    }
    catch (error) { if (!canApplyAnswerDialogMutation(answerState.selected, answer.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) { toast(error.message); return; } if (error.code === "revision_conflict") { $("#answer-conflict").classList.remove("hidden"); $("#answer-conflict").focus(); } else answerError(lifecycleErrorText(error), true); }
    finally { if (canApplyAnswerDialogMutation(answerState.selected, answer.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) setAnswerBusy(false); }
  }

  async function mergeCandidates(source) {
    const items = [];
    for (let offset = 0; ; offset += 200) {
      const result = await api("/api/answers/query", { method: "POST", body: JSON.stringify({ reviewStatus: "accepted", offset, limit: 200 }) });
      items.push(...result.items);
      if (!result.hasMore) break;
    }
    return items.filter((item) => item.key !== source.key && sameAnswerScope(item.scope, source.scope));
  }

  async function openAnswerMerge() {
    const source = answerState.selected; if (!source) return;
    if (answerState.dirty.size) {
      answerError("Save this draft or close the answer details to discard it before merging.", true);
      $("#answer-error").focus();
      return;
    }
    const dialogGeneration = answerState.dialogGeneration;
    const mergeRequestSequence = ++answerState.mergeRequestSequence;
    const error = $("#answer-merge-error"); error.classList.add("hidden");
    try {
      const candidates = await mergeCandidates(source);
      if (
        mergeRequestSequence !== answerState.mergeRequestSequence
        || !canApplyAnswerDialogResponse(answerState.selected, source.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)
        || answerState.selected.revision !== source.revision
        || answerState.dirty.size
      ) return;
      answerState.mergeSource = source;
      answerState.mergeCandidates = candidates;
      const select = $("#answer-merge-winner"); select.replaceChildren();
      select.append(new Option("Select an accepted winner", ""));
      for (const candidate of answerState.mergeCandidates) {
        select.append(new Option(`${candidate.question || candidate.key} · revision ${candidate.revision} · ${candidate.state} · ${answerSummary(candidate)}`, candidate.key));
      }
      const sourceLabel = source.question?.trim() || `Question not recorded (explicit key: ${source.key})`;
      const sourceValueStatus = source.hasValue ? "Its retained value will be discarded." : "It has no retained value to discard.";
      $("#answer-merge-source").textContent = `Duplicate source: ${sourceLabel} · ${source.reviewStatus} · revision ${source.revision}. ${sourceValueStatus}`;
      $("#answer-merge-confirm").disabled = answerState.mergeCandidates.length === 0;
      if (!answerState.mergeCandidates.length) {
        error.textContent = "No other accepted answer has this exact scope."; error.classList.remove("hidden");
      }
      $("#answer-merge-dialog").showModal(); setTimeout(() => select.focus(), 0);
    } catch (exception) { if (canApplyAnswerDialogResponse(answerState.selected, source.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) answerError(exception.message, true); }
  }

  async function submitAnswerMerge(event) {
    event.preventDefault();
    const source = answerState.mergeSource;
    const winner = answerState.mergeCandidates.find((item) => item.key === $("#answer-merge-winner").value);
    const dialogGeneration = answerState.dialogGeneration;
    const mergeRequestSequence = answerState.mergeRequestSequence;
    const error = $("#answer-merge-error"); error.classList.add("hidden");
    if (!source || !winner || answerState.selected?.key !== source.key || answerState.selected?.revision !== source.revision) { error.textContent = "The source answer changed. Close this confirmation and start the merge again."; error.classList.remove("hidden"); return; }
    setAnswerBusy(true);
    try {
      const merged = await api(answerApiPath(source.key, "merge"), { method: "POST", body: JSON.stringify({ winnerKey: winner.key, expectedWinnerRevision: winner.revision, expectedSourceRevision: source.revision }) });
      const currentDialog = canApplyAnswerDialogMutation(answerState.selected, source.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open);
      if (currentDialog) { answerState.opener = null; if ($("#answer-merge-dialog").open) $("#answer-merge-dialog").close(); $("#answer-dialog").close(); }
      await refreshAnswers({ reset: true });
      if (currentDialog) (document.querySelector(`.answer-card[data-key="${CSS.escape(merged.key)}"]`) || $("#answer-new")).focus(); toast("Duplicate merged into the selected canonical winner");
    } catch (exception) {
      if (mergeRequestSequence !== answerState.mergeRequestSequence || !canApplyAnswerDialogMutation(answerState.selected, source.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open && $("#answer-merge-dialog").open)) { toast(exception.message); return; }
      error.textContent = exception.status === 409 ? "The source or winner changed. Nothing was merged; close and reopen to select current revisions." : exception.message;
      error.classList.remove("hidden"); error.focus();
    } finally { if (canApplyAnswerDialogMutation(answerState.selected, source.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) setAnswerBusy(false); }
  }

  async function openAnswerCleanup() {
    const error = $("#answer-cleanup-error"); error.classList.add("hidden");
    try {
      const preview = await api("/api/answers/cleanup-preview");
      answerState.cleanupPreview = preview;
      const holder = $("#answer-cleanup-proposals"); holder.replaceChildren();
      for (const [index, proposal] of preview.proposals.entries()) {
        const label = document.createElement("label");
        const input = document.createElement("input"); input.type = "radio"; input.name = "proposal"; input.value = String(index); input.required = true;
        const copy = document.createElement("span");
        copy.textContent = `${statusLabel(proposal.confidenceBand)} confidence · keep “${proposal.winnerQuestion}” (${proposal.winnerKey}) · merge “${proposal.duplicateQuestion}” (${proposal.duplicateKey})`;
        label.append(input, copy); holder.append(label);
      }
      $("#answer-cleanup-confirm").disabled = preview.proposals.length === 0;
      if (!preview.proposals.length) {
        const empty = document.createElement("p"); empty.textContent = "No unambiguous cleanup proposals are available."; holder.append(empty);
      }
      $("#answer-cleanup-dialog").showModal();
    } catch (exception) {
      error.textContent = exception.message; error.classList.remove("hidden");
      toast(`Cleanup preview failed: ${exception.message}`);
    }
  }

  async function submitAnswerCleanup(event) {
    event.preventDefault();
    const preview = answerState.cleanupPreview;
    const selected = event.currentTarget.elements.proposal?.value;
    const proposal = preview?.proposals?.[Number(selected)];
    if (!preview || !proposal) return;
    try {
      await api("/api/answers/cleanup-approve", {
        method: "POST", body: JSON.stringify({
          ownerConfirmed: true,
          approval: {
            previewToken: preview.previewToken,
            winnerKey: proposal.winnerKey,
            duplicateKey: proposal.duplicateKey,
            winnerRevision: proposal.winnerRevision,
            duplicateRevision: proposal.duplicateRevision,
          },
        }),
      });
      $("#answer-cleanup-dialog").close();
      answerState.cleanupPreview = null;
      await refreshAnswers({ reset: true });
      toast("Exact cleanup proposal approved");
    } catch (error) {
      $("#answer-cleanup-error").textContent = error.message;
      $("#answer-cleanup-error").classList.remove("hidden");
    }
  }


  Object.assign(coordinators, { answerError, setAnswerBusy, renderAnswers, refreshAnswers, syncSensitiveConsent, populateAnswerForm, showAnswerDetail, openAnswer, newAnswer, answerFormPayload, saveAnswer, answerAction, mergeCandidates, openAnswerMerge, submitAnswerMerge, openAnswerCleanup, submitAnswerCleanup });
}
