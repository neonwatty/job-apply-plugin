export * from "./lib/api.js";
export * from "./lib/helpers.js";
export { bootstrapWorkspace, createWorkspaceContext } from "./bootstrap.js";

import { bootstrapWorkspace } from "./bootstrap.js";

if (typeof document !== "undefined") bootstrapWorkspace();
