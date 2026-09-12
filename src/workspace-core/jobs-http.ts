import { automationHttp } from './automation-http.js';
import { accountOperationHttp } from './account-operation-http.js';
import { trustedFillHttp } from './trusted-fill-http.js';
import { resumeLifecycleHttp } from './resume-lifecycle-http.js';
import { answerLifecycleHttp } from './answer-lifecycle-http.js';
import { trashHttp } from './trash-http.js';
import { claimsHttp } from './claims-http.js';
import { jobTransitionsHttp } from './job-transitions-http.js';
import { workspaceProjectionsHttp } from './workspace-projections-http.js';
import { pendingAnswersHttp } from './pending-answers-http.js';
import { profileHttp } from "./profile-http.js";
import type { JobsService } from "./jobs.js";
import type { NativeJobsRepository } from "../store/native-jobs.js";
import { fixtureError } from "../store/native-jobs.js";
import { JobsError, fromJSON, get, int, keys, object, parse, serialize, set } from "../contracts/workspace/values.js";
import type { Value } from "../contracts/workspace/values.js";
import { emptyObject } from "../contracts/workspace/jobs.js";
import { PythonObject } from "../contracts/python-object.js";
import { ResumeService } from "./resumes.js";
import { resumesHttp } from "./resumes-http.js";
import { answerHttp } from "./answers-http.js";
import { extractionHttp } from "./extractions-http.js";

export type ApiResult = { status: number; body: string | Buffer; contentType?: string; disposition?: string };
const response = (value: Value, status = 200): ApiResult => ({ status, body: serialize(value) });
export const apiError = (status: number, code: string, message: string): ApiResult =>
  response(fromJSON({ error: { code, message } }), status);
const envelope = (key: string, value: Value): Value => set(emptyObject(), key, value);

/** Transport-independent dispatch. Host/token/Origin/body bounds belong to the adapter. */
export async function jobsHttp(service: JobsService, repository: NativeJobsRepository,
  method: string, path: string, body = ""): Promise<ApiResult> {
  try {
    const trustedFill = await trustedFillHttp(repository, method, path, body);
    if (trustedFill) return trustedFill;
    const accountOperation = await accountOperationHttp(repository, method, path, body);
    if (accountOperation) return accountOperation;
    const automation = await automationHttp(repository, method, path, body);
    if (automation) return automation;
    const resumeLifecycle = await resumeLifecycleHttp(repository, method, path, body);
    if (resumeLifecycle) return resumeLifecycle;
    const answerLifecycle = await answerLifecycleHttp(repository, method, path, body);
    if (answerLifecycle) return answerLifecycle;
    const trash = await trashHttp(repository, method, path, body);
    if (trash) return trash;
    const transition = await jobTransitionsHttp(repository, method, path, body);
    if (transition) return transition;
    const projection = await workspaceProjectionsHttp(repository, method, path);
    if (projection) return projection;
    const claim = await claimsHttp(repository,method,path,body);
    if (claim) return claim;
    const pending = await pendingAnswersHttp(repository, method, path, body);
    if (pending) return pending;
    const extraction = await extractionHttp(repository, method, path, body);
    if (extraction) return extraction;
    const answers = await answerHttp(repository, method, path, body);
    if (answers) return answers;
    const resumes = await resumesHttp(new ResumeService(repository), method, path, body);
    if (resumes) return resumes;
    const facts = await profileHttp(repository, method, path, body);
    if (facts) return facts;
    if (method === "GET") {
      if (path === "/api/boot") {
        await service.list();
        return response(fromJSON({ status: "ready", mode: "native-jobs-fixture" }));
      }
      if (path === "/api/jobs") return response(envelope("jobs", await service.list()));
      if (path === "/api/state") {
        const state = object(envelope("jobs", await service.list()), "state");
        set(state, "resumes", await repository.resumeSummaries());
        return response(state);
      }
      const match = /^\/api\/jobs\/([^/]+)$/.exec(path);
      if (match) {
        const job = await service.get(decodeURIComponent(match[1]!));
        return job === null ? apiError(404, "not_found", "job does not exist") : response(job);
      }
    }
    if (method === "POST" && path === "/api/jobs") {
      const payload = object(parse(body), "body");
      if (payload.size !== 1 || keys(payload)[0] !== "job" || !(get(payload, "job") instanceof PythonObject)) {
        return apiError(400, "request_error", "body must contain only a job object");
      }
      return response(await service.create(get(payload, "job")));
    }
    const match = /^\/api\/jobs\/([^/]+)$/.exec(path);
    if (method === "PATCH" && match) {
      const payload = object(parse(body), "body");
      if (payload.size !== 2 || keys(payload).some(key => !["patch", "expectedRevision"].includes(key))
        || !(get(payload, "patch") instanceof PythonObject)) {
        return apiError(400, "request_error", "body requires patch and expectedRevision");
      }
      const revision = int(get(payload, "expectedRevision"));
      if (revision === null || revision < 1n) return apiError(400, "request_error", "expectedRevision must be a positive integer");
      return response(await service.update(decodeURIComponent(match[1]!), get(payload, "patch"), revision));
    }
    return apiError(501, "unsupported_native_workflow", "This workflow is not supported by the synthetic native workspace.");
  } catch (error) {
    if (error instanceof JobsError) {
      return error.message.includes("revision conflict") ? apiError(409, "revision_conflict", error.message)
        : ["resume proposal is stale", "answer cleanup preview is stale", "pending question reference is stale"].includes(error.message) ? apiError(409, "stale_conflict", error.message)
        : error.message === "proposal review baseline changed" ? apiError(409, "baseline_conflict", error.message)
        : error.message.includes("content is too large") ? apiError(413, "request_error", error.message)
        : error.message === "managed resume content is unavailable" ? apiError(409, "content_unavailable", error.message)
        : error.message.includes("does not exist") ? apiError(404, "not_found", error.message)
        : error.message === "active job URL already exists" ? apiError(409, "duplicate_active_blocked", error.message)
        : ["resume id already exists", "resume file is already managed"].includes(error.message) ? apiError(409, "duplicate_resume_blocked", error.message)
        : apiError(400, "store_rejected", error.message);
    }
    if (error instanceof Error && ["JSONDecodeError", "ValueError"].includes(error.name)) {
      return apiError(400, "request_error", "body must be valid JSON");
    }
    return apiError(503, "store_unavailable", fixtureError(error));
  }
}
