import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { validToken, type LocalConfig } from "./config";
import { bounded, failure } from "./forward";

const execute = promisify(execFile);
const path = "/api/submission-lab";
const limit = 4096;
const actions = new Set(["set-approval", "start", "check-reviews", "preview", "approve", "execute", "stop", "end"]);

export async function submissionLab(request: Request, config: LocalConfig): Promise<Response> {
  const root = process.env.COMPANION_SUBMISSION_LAB_ROOT, plugin = process.env.COMPANION_SUBMISSION_LAB_PLUGIN;
  const store = process.env.COMPANION_SUBMISSION_LAB_STORE;
  if (!root || !plugin || !store) return failure(404, "not_found", "The submission lab is unavailable.");
  if (!validToken(request.headers.get("authorization"), config.token)) {
    return failure(401, "token_rejected", "workspace token is missing or invalid");
  }
  const url = new URL(request.url);
  const load = request.method === "GET" && url.pathname === path;
  const action = load ? "load" : url.pathname.slice(path.length + 1);
  if (url.search || url.hash || (!load && (request.method !== "POST" || !actions.has(action)))) {
    return failure(404, "not_found", "route not found");
  }
  let body = "{}";
  if (!load) {
    if (request.headers.get("origin") !== config.origin) {
      return failure(403, "origin_rejected", "request origin is not the workspace");
    }
    if (request.headers.get("content-type") !== "application/json") {
      return failure(415, "request_error", "Content-Type must be application/json");
    }
    const length = request.headers.get("content-length");
    if (length === null || !/^\d+$/.test(length) || Number(length) > limit) {
      return failure(400, "request_error", "invalid submission lab body length");
    }
    try {
      const bytes = await bounded(request.body, limit, 5000);
      if (bytes.length !== Number(length)) throw new Error();
      body = JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      return failure(400, "request_error", "invalid submission lab request");
    }
  }
  let stdout: unknown;
  try {
    ({ stdout } = await execute(process.execPath, [join(plugin, "runtime/cli/companion-submission-lab.js"), action, body], {
      cwd: plugin, env: { ...process.env, JOB_APPLY_QA_RUNS_ROOT: root, JOB_APPLY_STORE_DIR: store },
      timeout: 25_000, maxBuffer: 128 * 1024, windowsHide: true,
    }));
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout;
  }
  try {
    if (typeof stdout !== "string") throw new Error();
    const reply = JSON.parse(stdout);
    if (typeof reply.error === "string") return failure(409, "submission_lab_conflict", reply.error);
    if (!Object.hasOwn(reply, "result")) throw new Error();
    return Response.json(reply.result, { headers: {
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return failure(502, "submission_lab_unavailable", "The submission lab is unavailable. Refresh to check its current state.");
  }
}
