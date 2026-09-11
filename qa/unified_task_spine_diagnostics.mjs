const PUBLIC_STAGES = new Set([
  "setup", "ux_intake", "agent_intake", "selection", "first_acquisition",
  "attention_open", "answer_open", "answer_save", "answer_recheck",
  "second_acquisition", "resume_continuity", "review_fixture", "review_handoff",
  "final_verification", "cleanup",
  "answer_save_response", "answer_save_closed", "answer_save_activity",
  "answer_save_draft", "answer_save_focus_wait",
]);

export class OracleFailure extends Error {
  constructor(code, stage = "cleanup") {
    super(code);
    this.stage = stage;
  }
}

export function publicFailureReport(error) {
  return {
    schemaVersion: 1,
    oracle: "unified_task_spine",
    result: "fail",
    closed: true,
    error: "oracle_failed",
    stage: PUBLIC_STAGES.has(error?.stage) ? error.stage : "unknown",
  };
}

