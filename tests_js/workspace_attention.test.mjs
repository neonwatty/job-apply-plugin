import {
  assert, attentionAnnouncement, attentionMembershipSignature, newestCanonicalJob, test,
} from "./workspace_test_support.mjs";

test("Needs Attention announcements ignore revision-only polls and report membership changes", () => {
  const before = { items: [{ jobId: "job-one", reasonCode: "needs_information", revision: 2 }] };
  const revisionOnly = { items: [{ jobId: "job-one", reasonCode: "needs_information", revision: 3 }] };
  const changed = { items: [{ jobId: "job-one", reasonCode: "awaiting_human_review", revision: 4 }, { jobId: "job-two", reasonCode: "needs_information", revision: 1 }] };
  assert.equal(attentionAnnouncement(null, before), "");
  assert.equal(attentionAnnouncement(before, revisionOnly), "");
  assert.match(attentionAnnouncement(before, changed), /2 jobs now require action/);
  assert.equal(attentionMembershipSignature(before).includes("revision"), false);
});


test("attention detail selection keeps the highest canonical job revision", () => {
  const older = { id: "job-one", revision: 4, role: "Older" };
  const newer = { id: "job-one", revision: 5, role: "Newer" };
  assert.equal(newestCanonicalJob(null, older), older);
  assert.equal(newestCanonicalJob(newer, older), newer);
  assert.equal(newestCanonicalJob(older, newer), newer);
  assert.equal(newestCanonicalJob(newer, { id: "other-job", revision: 99 }), newer);
});
