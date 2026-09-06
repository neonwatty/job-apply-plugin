const TOP_KEYS = ["schemaVersion", "corpus", "source", "fixture", "inventory", "cases", "redaction"];
const CASE_KEYS = [
  "scenario", "command", "args", "exitCode", "stdout", "stderr", "nonceCalls",
  "effects", "idempotence", "rejectionImmutability",
];
const SCENARIOS = [
  ["settings-missing-controls", "automation-settings-get", [
    "account-operation-journal.json", "automation-settings.json", "employer-accounts.json",
  ]],
  ["accounts-missing-controls", "employer-account-list", [
    "account-operation-journal.json", "automation-settings.json", "employer-accounts.json",
  ]],
  ["settings-pending-account-journal", "automation-settings-get", []],
  ["accounts-pending-account-journal", "employer-account-list", []],
  ["claim-missing-controls", "claim-status", ["coordinator-journal.json", "coordinator.json"]],
  ["claim-pending-recovery", "claim-status", [
    "applications.jsonl", "coordinator-journal.json", "coordinator.json",
  ]],
  ["corrupt-settings-no-write", "automation-settings-get", []],
  ["future-coordinator-no-write", "claim-status", []],
];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}_object_required`);
  }
}

function closed(value, keys, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!keys.includes(key)) {
    throw new Error(`${label}_unknown_field`);
  }
}

function required(value, keys, label) {
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`${label}_required_field`);
}

function stringArray(value, label, { unique = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${label}_invalid`);
  }
  if (unique && new Set(value).size !== value.length) throw new Error(`${label}_invalid`);
}

function jsonValue(value, label) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label}_non_finite`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item) => jsonValue(item, label));
  object(value, label);
  Object.values(value).forEach((item) => jsonValue(item, label));
}

function fileState(value, label) {
  if (value === null) return;
  closed(value, ["digest", "size", "modeContract"], label);
  required(value, ["digest", "size", "modeContract"], label);
  if (!/^[a-f0-9]{64}$/.test(value.digest) || !Number.isInteger(value.size) || value.size < 0
    || value.modeContract !== "private-file-0600-posix") {
    throw new Error(`${label}_invalid`);
  }
}

function effects(value, expected) {
  closed(value, ["expectedWrites", "observedWrites", "documents", "untouchedEntriesUnchanged"], "effects");
  required(value, ["expectedWrites", "observedWrites", "documents", "untouchedEntriesUnchanged"], "effects");
  stringArray(value.expectedWrites, "expected_writes", { unique: true });
  stringArray(value.observedWrites, "observed_writes", { unique: true });
  if (JSON.stringify(value.expectedWrites) !== JSON.stringify(expected)
    || JSON.stringify(value.observedWrites) !== JSON.stringify(expected)
    || value.untouchedEntriesUnchanged !== true
    || !Array.isArray(value.documents) || value.documents.length !== expected.length) {
    throw new Error("effects_invalid");
  }
  value.documents.forEach((document, index) => {
    closed(document, ["path", "before", "after", "mtimeChanged"], "effect_document");
    required(document, ["path", "before", "after", "mtimeChanged"], "effect_document");
    if (document.path !== expected[index] || document.mtimeChanged !== true) {
      throw new Error("effect_document_invalid");
    }
    fileState(document.before, "effect_before");
    fileState(document.after, "effect_after");
    if (document.before === null && document.after === null) throw new Error("effect_document_invalid");
  });
}

function validateCase(item, definition) {
  const [scenario, command, writes] = definition;
  closed(item, CASE_KEYS, "case");
  const rejection = scenario.endsWith("no-write");
  const needed = CASE_KEYS.slice(0, 8).concat(rejection ? ["rejectionImmutability"] : ["idempotence"]);
  required(item, needed, "case");
  if (Object.keys(item).length !== needed.length || item.scenario !== scenario || item.command !== command
    || JSON.stringify(item.args) !== JSON.stringify([command]) || item.nonceCalls !== 0
    || typeof item.stderr !== "string") throw new Error("case_identity_invalid");
  jsonValue(item.stdout, "stdout");
  effects(item.effects, writes);
  if (rejection) {
    if (item.exitCode !== 2 || item.stdout !== null) throw new Error("rejection_result_invalid");
    closed(item.rejectionImmutability, ["treeUnchanged"], "rejection_immutability");
    required(item.rejectionImmutability, ["treeUnchanged"], "rejection_immutability");
    if (item.rejectionImmutability.treeUnchanged !== true) throw new Error("rejection_immutability_invalid");
  } else {
    if (item.exitCode !== 0 || item.stderr !== "") throw new Error("success_result_invalid");
    closed(item.idempotence, ["resultUnchanged", "treeUnchanged", "nonceCalls"], "idempotence");
    required(item.idempotence, ["resultUnchanged", "treeUnchanged", "nonceCalls"], "idempotence");
    if (item.idempotence.resultUnchanged !== true || item.idempotence.treeUnchanged !== true
      || item.idempotence.nonceCalls !== 0) throw new Error("idempotence_invalid");
  }
}

export function validateStartupCorpus(corpus) {
  closed(corpus, TOP_KEYS, "corpus");
  required(corpus, TOP_KEYS, "corpus");
  if (corpus.schemaVersion !== 1 || corpus.corpus !== "python-store-startup-read-v1"
    || corpus.source !== "python-store-cli") throw new Error("corpus_identity_invalid");
  closed(corpus.fixture, ["kind", "clock", "noncePolicy"], "fixture");
  required(corpus.fixture, ["kind", "clock", "noncePolicy"], "fixture");
  if (corpus.fixture.kind !== "synthetic-initialized-store-clones"
    || corpus.fixture.clock !== "2026-09-05T00:00:00Z"
    || corpus.fixture.noncePolicy !== "fail-on-use-and-record-zero") throw new Error("fixture_invalid");
  closed(corpus.inventory, ["total", "commands", "captured", "pending"], "inventory");
  required(corpus.inventory, ["total", "commands", "captured", "pending"], "inventory");
  stringArray(corpus.inventory.commands, "inventory_commands", { unique: true });
  stringArray(corpus.inventory.captured, "captured_commands", { unique: true });
  if (corpus.inventory.total !== 98 || corpus.inventory.commands.length !== 98
    || corpus.inventory.pending !== 95
    || JSON.stringify(corpus.inventory.captured) !== JSON.stringify([
      "automation-settings-get", "employer-account-list", "claim-status",
    ]) || corpus.inventory.captured.some((name) => !corpus.inventory.commands.includes(name))) {
    throw new Error("inventory_invalid");
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length !== SCENARIOS.length) {
    throw new Error("cases_invalid");
  }
  corpus.cases.forEach((item, index) => validateCase(item, SCENARIOS[index]));
  closed(corpus.redaction, ["secretCanaryAbsent", "absolutePathsAbsent", "checkedSurfaces"], "redaction");
  required(corpus.redaction, ["secretCanaryAbsent", "absolutePathsAbsent", "checkedSurfaces"], "redaction");
  if (corpus.redaction.secretCanaryAbsent !== true || corpus.redaction.absolutePathsAbsent !== true
    || JSON.stringify(corpus.redaction.checkedSurfaces) !== JSON.stringify([
      "stdout", "stderr", "fixture-descriptors", "effects", "artifact",
    ])) throw new Error("redaction_invalid");
  return corpus;
}

export function canonicalStartupCorpus(corpus) {
  validateStartupCorpus(corpus);
  return `${JSON.stringify(corpus, null, 2)}\n`;
}
