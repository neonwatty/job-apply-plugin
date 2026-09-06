import assert from "node:assert/strict";
import test from "node:test";
import * as reference from "../workspace/lib/helpers.js";
import * as port from "../runtime/workspace-ui/lib/resume-view.js";

function compare(name, args) {
  assert.deepEqual(port[name](...args), reference[name](...args), name);
}

test("inert resume view module exposes exactly the four existing helpers", () => {
  assert.deepEqual(Object.keys(port).sort(), [
    "extractionRequestView", "proposalGroupForPath", "resumeAssignmentText", "shouldUseResumeResponse",
  ]);
});

test("assignment text retains exact counts, pluralization and noninteger defaults", () => {
  for (const [resume, expected] of [
    [undefined, "0 explicitly assigned active jobs."],
    [{ assignedJobCount: 1 }, "1 explicitly assigned active job."],
    [{ assignedJobCount: 2, implicitJobCount: 1 }, "2 explicitly assigned active jobs; 1 active job use this default."],
    [{ assignedJobCount: 0, implicitJobCount: 2 }, "0 explicitly assigned active jobs; 2 active jobs use this default."],
    [{ assignedJobCount: "1", implicitJobCount: 0.5 }, "0 explicitly assigned active jobs."],
    [{ assignedJobCount: -1, implicitJobCount: -2 }, "-1 explicitly assigned active jobs; -2 active jobs use this default."],
  ]) {
    assert.equal(port.resumeAssignmentText(resume), expected);
    compare("resumeAssignmentText", [resume]);
  }
  const counts = [undefined, null, 0, -0, 1, 2, -1, 0.5, NaN, Infinity, "2", true, 1n, [], {}];
  for (const assignedJobCount of counts) {
    for (const implicitJobCount of counts) {
      compare("resumeAssignmentText", [{ assignedJobCount, implicitJobCount }]);
    }
  }
  for (const value of [null, false, 0, "", "text", 1n, Symbol("synthetic"), []]) {
    compare("resumeAssignmentText", [value]);
  }
});

test("extraction view preserves every state's exact user-facing response", () => {
  for (const [request, proposal, expected] of [
    [null, null, { label: "Facts not extracted", action: "request", tone: "neutral" }],
    [{ status: "cancelled" }, null, { label: "Facts not extracted", action: "request", tone: "neutral" }],
    [{ status: "requested" }, null, { label: "Waiting for a Job Apply agent", action: "cancel", tone: "waiting" }],
    [{ status: "failed" }, null, { label: "Fact extraction did not complete", action: "retry", tone: "warning" }],
    [{ status: "stale" }, null, { label: "The resume changed after this request", action: "fresh", tone: "warning" }],
    [{ status: "completed" }, { status: "pending", staleReasons: ["changed"] },
      { label: "Extraction review is no longer current", action: "fresh", tone: "warning" }],
    [{ status: "completed" }, { status: "pending", staleReasons: [] },
      { label: "Extracted changes need review", action: "review", tone: "review" }],
    [{ status: "completed" }, { status: "completed" },
      { label: "Extracted facts were applied or reviewed", action: "facts", tone: "complete" }],
  ]) {
    assert.deepEqual(port.extractionRequestView(request, proposal), expected);
    compare("extractionRequestView", [request, proposal]);
  }
  const requests = [undefined, null, false, 0, "", "text", [], {},
    ...["cancelled", "requested", "failed", "stale", "completed", "future"].map((status) => ({ status }))];
  const proposals = [undefined, null, false, "pending", {}, { status: "future" },
    ...[undefined, null, [], ["changed"], "", "changed", 2, { length: -1 }, { length: "0" }]
      .map((staleReasons) => ({ status: "pending", staleReasons }))];
  for (const request of requests) {
    for (const proposal of proposals) compare("extractionRequestView", [request, proposal]);
  }
});

test("proposal grouping preserves known groups and existing path coercion", () => {
  const groups = {
    Identity: ["firstName", "lastName"], Contact: ["email", "phone"], Location: ["location"],
    Experience: ["workHistory"], Education: ["education"], Skills: ["skills"],
    Links: ["linkedInUrl", "portfolioUrl", "githubUrl"],
  };
  for (const [group, fields] of Object.entries(groups)) {
    for (const field of fields) {
      for (const path of [`/${field}`, `/${field}/nested`, `prefix/${field}`]) {
        assert.equal(port.proposalGroupForPath(path), group);
        compare("proposalGroupForPath", [path]);
      }
    }
  }
  for (const path of [undefined, null, "", "/", "skills", "/future/value", "/Skills", 0, false, {}, [], Symbol("x")]) {
    assert.equal(port.proposalGroupForPath(path), "Additional");
    compare("proposalGroupForPath", [path]);
  }
  compare("proposalGroupForPath", [{ toString: () => "/skills" }]);
});

test("resume responses require both the same request and the same view without coercion", () => {
  for (const sameRequest of [false, true]) {
    for (const requestedTrash of [false, true]) {
      for (const currentTrash of [false, true]) {
        const args = [sameRequest ? 4 : 3, 4, requestedTrash, currentTrash];
        assert.equal(port.shouldUseResumeResponse(...args), sameRequest && requestedTrash === currentTrash);
        compare("shouldUseResumeResponse", args);
      }
    }
  }
  const shared = {};
  for (const args of [["4", 4, false, false], [NaN, NaN, true, true], [0, -0, 0, false],
    [undefined, undefined, null, null], [shared, shared, shared, shared], [{}, {}, true, true]]) {
    compare("shouldUseResumeResponse", args);
  }
});

test("pure helpers leave caller projections unchanged", () => {
  const resume = Object.freeze({ assignedJobCount: 2, implicitJobCount: 1 });
  const request = Object.freeze({ status: "completed" });
  const proposal = Object.freeze({ status: "pending", staleReasons: Object.freeze(["changed"]) });
  const before = structuredClone({ resume, request, proposal });
  port.resumeAssignmentText(resume);
  const first = port.extractionRequestView(request, proposal);
  const second = port.extractionRequestView(request, proposal);
  assert.notEqual(first, second);
  port.proposalGroupForPath("/skills");
  port.shouldUseResumeResponse(request, request, false, false);
  assert.deepEqual({ resume, request, proposal }, before);
});
