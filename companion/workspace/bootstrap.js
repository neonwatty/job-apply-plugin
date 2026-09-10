import { createApi, safeSessionStorage, sessionToken } from "./lib/api.js";
import { createDom } from "./lib/dom.js";
import { createCoordinators, createWorkspaceState } from "./lib/state.js";
import { installActivity } from "./features/activity.js";
import { installAnswers } from "./features/answers.js";
import { installAutomation } from "./features/automation.js";
import { installBindings } from "./features/bindings.js";
import { installFacts } from "./features/facts.js";
import { installJobs } from "./features/jobs.js";
import { installNavigation } from "./features/navigation.js";
import { installOverview } from "./features/overview.js";
import { installResumes } from "./features/resumes.js";
import { installTrash } from "./features/trash.js";

const FEATURE_INSTALLERS = [
  installOverview, installFacts, installTrash, installAutomation, installNavigation,
  installAnswers, installResumes, installJobs, installActivity, installBindings,
];

export function createWorkspaceContext(token, fetchImpl = globalThis.fetch) {
  const state = createWorkspaceState();
  return {
    api: createApi(token, fetchImpl), state,
    dom: createDom(state, token), coordinators: createCoordinators(),
  };
}

export function bootstrapWorkspace(scope = globalThis) {
  const token = sessionToken(scope.location.hash, safeSessionStorage(scope));
  if (scope.location.hash) scope.history.replaceState(null, "", scope.location.pathname);
  const context = createWorkspaceContext(token);
  for (const install of FEATURE_INSTALLERS) install(context);
  return context;
}
