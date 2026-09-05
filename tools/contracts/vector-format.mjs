const TOP_KEYS = ["schemaVersion", "corpus", "source", "fixture", "inventory", "cases", "redaction"];
const CASE_KEYS = ["scenario", "command", "args", "exitCode", "stdout", "stderr", "storeUnchanged", "rejectionImmutability"];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_object_required`);
}

function closed(value, keys, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label}_unknown_field`);
}

function jsonValue(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label}_non_finite`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) jsonValue(item, label);
    return;
  }
  object(value, label);
  for (const item of Object.values(value)) jsonValue(item, label);
}

export function validateCorpus(corpus) {
  closed(corpus, TOP_KEYS, "corpus");
  if (corpus.schemaVersion !== 1 || corpus.corpus !== "python-store-read-v1" || corpus.source !== "python-store-cli") throw new Error("corpus_identity_invalid");
  closed(corpus.fixture, ["kind", "clock", "noncePolicy"], "fixture");
  if (corpus.fixture.kind !== "synthetic-empty-store" || corpus.fixture.clock !== "2026-09-05T00:00:00Z" || corpus.fixture.noncePolicy !== "not-used-by-captured-reads") throw new Error("fixture_invalid");
  closed(corpus.inventory, ["total", "commands", "captured", "pending"], "inventory");
  if (corpus.inventory.total !== 98 || corpus.inventory.pending !== 98 - corpus.inventory.captured.length) throw new Error("inventory_count_invalid");
  if (!Array.isArray(corpus.inventory.commands) || corpus.inventory.commands.length !== 98 || new Set(corpus.inventory.commands).size !== 98) throw new Error("inventory_commands_invalid");
  if (!Array.isArray(corpus.inventory.captured) || corpus.inventory.captured.some((name) => !corpus.inventory.commands.includes(name))) throw new Error("captured_commands_invalid");
  if (!Array.isArray(corpus.cases) || corpus.cases.length !== corpus.inventory.captured.length + 2) throw new Error("cases_invalid");
  for (const item of corpus.cases) {
    closed(item, CASE_KEYS, "case");
    if (!corpus.inventory.commands.includes(item.command) || !Array.isArray(item.args) || item.args[0] !== item.command) throw new Error("case_command_invalid");
    if (![0, 2].includes(item.exitCode) || typeof item.stderr !== "string" || typeof item.storeUnchanged !== "boolean") throw new Error("case_result_invalid");
    jsonValue(item.stdout, "stdout");
    if (item.exitCode === 0 && (item.stderr !== "" || item.storeUnchanged !== true || "rejectionImmutability" in item)) throw new Error("success_case_invalid");
    if (item.exitCode === 2) {
      closed(item.rejectionImmutability, ["bytesUnchanged", "mtimeNsUnchanged"], "immutability");
      if (!item.rejectionImmutability.bytesUnchanged || !item.rejectionImmutability.mtimeNsUnchanged || item.stdout !== null) throw new Error("rejection_case_invalid");
    }
  }
  closed(corpus.redaction, ["secretCanaryAbsent", "absolutePathsAbsent", "checkedSurfaces"], "redaction");
  if (corpus.redaction.secretCanaryAbsent !== true || corpus.redaction.absolutePathsAbsent !== true) throw new Error("redaction_invalid");
  if (JSON.stringify(corpus.redaction.checkedSurfaces) !== JSON.stringify(["stdout", "stderr", "fixture-descriptors", "artifact"])) throw new Error("redaction_surfaces_invalid");
  return corpus;
}

export function canonicalCorpus(corpus) {
  validateCorpus(corpus);
  return `${JSON.stringify(corpus, null, 2)}\n`;
}

function inspectionText(value) {
  if (typeof value === "string") {
    try { return inspectionText(JSON.parse(value)); } catch { return value; }
  }
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(inspectionText).join("\n");
  if (typeof value === "object") return Object.entries(value)
    .flatMap(([key, item]) => [key, inspectionText(item)]).join("\n");
  return String(value);
}

export function secretCanaryPresent(value) {
  return /contract_secret_canary/i.test(inspectionText(value));
}

export function absolutePathPresent(value) {
  const content = inspectionText(value);
  return [
    /\/tmp\//i,
    /\/(?:home|users|var|private|opt|etc)\//i,
    /\\temp\\/i,
    /[a-z]:\\(?:users|temp)\\/i,
    /^\\\\[^\\]+\\/m,
  ].some((pattern) => pattern.test(content));
}

export function redactionViolations(value) {
  const content = inspectionText(value);
  const forbidden = [
    /(?:^|[^a-z])bearer\s+[a-z0-9._-]+/i,
    /(?:^|[^a-z])sk-[a-z0-9_-]+/i,
  ];
  return secretCanaryPresent(value) || absolutePathPresent(value)
    || forbidden.some((pattern) => pattern.test(content));
}
