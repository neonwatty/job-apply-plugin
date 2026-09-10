import * as helpers from "../lib/helpers.js";

export function installTrash(context) {
  const { api, state: stores, dom, coordinators } = context;
  const {
    resume: resumeState,
    answer: answerState,
    trash: trashState,
  } = stores;
  const {
    $,
    dialog,
    toast,
    setConnection,
  } = dom;
  const {
    trashRefreshCoordinator,
  } = coordinators;
  const {
    answerApiPath,
    typedDeletePhrase,
    filterTrashItems,
    trashBlockerText,
    lifecycleErrorText,
  } = helpers;
  const refreshAnswers = (...args) => coordinators.refreshAnswers(...args);
  const refreshResumes = (...args) => coordinators.refreshResumes(...args);
  const refresh = (...args) => coordinators.refresh(...args);
  function trashActionPath(item, action) {
    if (item.type === "answer") return answerApiPath(item.id, action);
    return `/api/${item.type === "resume" ? "resumes" : "jobs"}/${encodeURIComponent(item.id)}/${action}`;
  }

  function renderTrash() {
    const type = $("#trash-type-filter").value;
    const items = filterTrashItems(trashState.items, type);
    $("#trash-nav-count").textContent = String(trashState.items.length);
    $("#trash-counts").textContent = `${trashState.counts.job} jobs · ${trashState.counts.resume} resumes · ${trashState.counts.answer} answers`;
    $("#trash-status").textContent = `${items.length} trashed ${type || "record"}${items.length === 1 ? "" : "s"} in this view.`;
    $("#trash-empty").classList.toggle("hidden", items.length !== 0);
    const list = $("#trash-list"); list.replaceChildren();
    for (const item of items) {
      const card = document.createElement("article"); card.className = "trash-card"; card.setAttribute("role", "listitem");
      const body = document.createElement("div"); const kind = document.createElement("p"); kind.className = "eyebrow"; kind.textContent = item.type;
      const heading = document.createElement("h3"); heading.textContent = item.label; const detail = document.createElement("p"); detail.textContent = trashBlockerText(item); body.append(kind, heading, detail);
      const actions = document.createElement("div"); actions.className = "button-row";
      const restore = document.createElement("button"); restore.type = "button"; restore.className = "button secondary"; restore.textContent = "Restore";
      restore.addEventListener("click", () => restoreTrashItem(item, restore));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "button danger"; remove.textContent = "Delete permanently…";
      remove.addEventListener("click", () => openTrashDelete(item, remove)); actions.append(restore, remove); card.append(body, actions); list.append(card);
    }
  }

  async function refreshTrash({ quiet = false } = {}) {
    await trashRefreshCoordinator.run(
      () => api("/api/trash"),
      (result) => {
        trashState.items = result.items; trashState.counts = result.counts; trashState.loaded = true; renderTrash(); setConnection(true);
        $("#trash-error").classList.add("hidden"); if (!quiet) toast("Trash refreshed from the canonical store");
      },
      (error) => { const node = $("#trash-error"); node.textContent = error.message; node.classList.remove("hidden"); setConnection(false, error.message); },
    );
  }

  async function restoreTrashItem(item, control) {
    control.disabled = true;
    try {
      await api(trashActionPath(item, "restore"), { method: "POST", body: JSON.stringify({ expectedRevision: item.revision }) });
      await Promise.all([refresh({ quiet: true }), refreshTrash({ quiet: true })]); toast(`${item.type} restored`);
    } catch (error) {
      const node = $("#trash-error"); node.textContent = lifecycleErrorText(error); node.classList.remove("hidden");
      if (error.code === "revision_conflict") await refreshTrash({ quiet: true });
    } finally { control.disabled = false; }
  }

  function openTrashDelete(item, opener) {
    trashState.selected = { ...item }; trashState.opener = opener;
    const phrase = typedDeletePhrase(item.type); $("#trash-delete-identity").textContent = `${item.type}: ${item.label}`; $("#trash-delete-phrase").textContent = phrase;
    $("#trash-delete-impact").textContent = item.type === "resume"
      ? "This permanently deletes the selected canonical resume record and its managed resume file. It does not affect unrelated jobs or erase application history, sessions, or audit evidence."
      : "This permanently deletes only the selected canonical record. It does not cascade or erase application history, sessions, or audit evidence.";
    $("#trash-delete-input").value = ""; $("#trash-delete-confirm").disabled = true; $("#trash-delete-error").classList.add("hidden"); $("#trash-delete-conflict").classList.add("hidden");
    $("#trash-delete-dialog").showModal(); setTimeout(() => $("#trash-delete-input").focus(), 0);
  }

  async function submitTrashDelete(event) {
    event.preventDefault(); const item = trashState.selected; if (!item) return;
    if ($("#trash-delete-input").value !== typedDeletePhrase(item.type)) return;
    $("#trash-delete-confirm").disabled = true;
    try {
      await api(trashActionPath(item, "delete"), { method: "POST", body: JSON.stringify({ expectedRevision: item.revision }) });
      $("#trash-delete-dialog").close();
      if (item.type === "answer" && $("#answer-dialog").open) $("#answer-dialog").close();
      if (item.type === "resume" && $("#resume-dialog").open) $("#resume-dialog").close();
      await Promise.all([refresh({ quiet: true }), refreshTrash({ quiet: true }), answerState.loaded ? refreshAnswers() : Promise.resolve(), resumeState.loaded ? refreshResumes({ quiet: true }) : Promise.resolve()]); toast(`${item.type} permanently deleted`);
    } catch (error) {
      if (error.code === "revision_conflict") { $("#trash-delete-conflict").classList.remove("hidden"); $("#trash-delete-conflict").focus(); }
      else { $("#trash-delete-error").textContent = lifecycleErrorText(error); $("#trash-delete-error").classList.remove("hidden"); }
      $("#trash-delete-confirm").disabled = false;
    }
  }


  Object.assign(coordinators, { trashActionPath, renderTrash, refreshTrash, restoreTrashItem, openTrashDelete, submitTrashDelete });
}
