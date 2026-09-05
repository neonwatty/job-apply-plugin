const TOP_KEYS = ["schemaVersion", "corpus", "source", "fixture", "inventory", "cases", "redaction"];
const CASE_KEYS = ["scenario", "command", "args", "exitCode", "stdout", "stderr", "storeUnchanged", "rejectionImmutability"];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_object_required`);
}

function closed(value, keys, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label}_unknown_field`);
}

function required(value, keys, label) {
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`${label}_required_field`);
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
  required(corpus, TOP_KEYS, "corpus");
  if (corpus.schemaVersion !== 1 || corpus.corpus !== "python-store-read-v1" || corpus.source !== "python-store-cli") throw new Error("corpus_identity_invalid");
  closed(corpus.fixture, ["kind", "clock", "noncePolicy"], "fixture");
  required(corpus.fixture, ["kind", "clock", "noncePolicy"], "fixture");
  if (corpus.fixture.kind !== "synthetic-empty-store" || corpus.fixture.clock !== "2026-09-05T00:00:00Z" || corpus.fixture.noncePolicy !== "not-used-by-captured-reads") throw new Error("fixture_invalid");
  closed(corpus.inventory, ["total", "commands", "captured", "pending"], "inventory");
  required(corpus.inventory, ["total", "commands", "captured", "pending"], "inventory");
  if (corpus.inventory.total !== 98 || corpus.inventory.pending !== 98 - corpus.inventory.captured.length) throw new Error("inventory_count_invalid");
  if (!Array.isArray(corpus.inventory.commands) || corpus.inventory.commands.length !== 98 || new Set(corpus.inventory.commands).size !== 98) throw new Error("inventory_commands_invalid");
  if (!Array.isArray(corpus.inventory.captured) || new Set(corpus.inventory.captured).size !== corpus.inventory.captured.length || corpus.inventory.captured.some((name) => !corpus.inventory.commands.includes(name))) throw new Error("captured_commands_invalid");
  if (!Array.isArray(corpus.cases) || corpus.cases.length !== corpus.inventory.captured.length + 2) throw new Error("cases_invalid");
  for (const item of corpus.cases) {
    closed(item, CASE_KEYS, "case");
    required(item, CASE_KEYS.slice(0, -1), "case");
    if (!corpus.inventory.commands.includes(item.command) || !Array.isArray(item.args) || item.args[0] !== item.command || item.args.some((arg) => typeof arg !== "string")) throw new Error("case_command_invalid");
    if (![0, 2].includes(item.exitCode) || typeof item.stderr !== "string" || typeof item.storeUnchanged !== "boolean") throw new Error("case_result_invalid");
    jsonValue(item.stdout, "stdout");
    if (item.exitCode === 0 && (item.stderr !== "" || item.storeUnchanged !== true || "rejectionImmutability" in item)) throw new Error("success_case_invalid");
    if (item.exitCode === 2) {
      closed(item.rejectionImmutability, ["bytesUnchanged", "mtimeNsUnchanged"], "immutability");
      required(item.rejectionImmutability, ["bytesUnchanged", "mtimeNsUnchanged"], "immutability");
      if (!item.storeUnchanged || !item.rejectionImmutability.bytesUnchanged || !item.rejectionImmutability.mtimeNsUnchanged || item.stdout !== null) throw new Error("rejection_case_invalid");
    }
  }
  const successful = corpus.cases.filter((item) => item.exitCode === 0);
  if (JSON.stringify(successful.map((item) => item.command)) !== JSON.stringify(corpus.inventory.captured) || successful.some((item) => item.scenario !== "initialized-empty")) throw new Error("success_inventory_invalid");
  const rejected = corpus.cases.filter((item) => item.exitCode === 2);
  if (JSON.stringify(rejected.map((item) => item.scenario)) !== JSON.stringify(["corrupt-profile", "future-profile"]) || rejected.some((item) => item.command !== "profile-inspect")) throw new Error("rejection_inventory_invalid");
  closed(corpus.redaction, ["secretCanaryAbsent", "absolutePathsAbsent", "checkedSurfaces"], "redaction");
  required(corpus.redaction, ["secretCanaryAbsent", "absolutePathsAbsent", "checkedSurfaces"], "redaction");
  if (corpus.redaction.secretCanaryAbsent !== true || corpus.redaction.absolutePathsAbsent !== true) throw new Error("redaction_invalid");
  if (JSON.stringify(corpus.redaction.checkedSurfaces) !== JSON.stringify(["stdout", "stderr", "fixture-descriptors", "artifact"])) throw new Error("redaction_surfaces_invalid");
  return corpus;
}

export function canonicalCorpus(corpus) {
  validateCorpus(corpus);
  return `${JSON.stringify(corpus, null, 2)}\n`;
}

function inspectionEntries(value, key = null) {
  if (typeof value === "string") {
    try { return inspectionEntries(JSON.parse(value), key); } catch { return [{ key, text: value }]; }
  }
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => inspectionEntries(item, key));
  if (typeof value === "object") return Object.entries(value)
    .flatMap(([childKey, item]) => [{ key: null, text: childKey }, ...inspectionEntries(item, childKey)]);
  return [{ key, text: String(value) }];
}

function inspectionText(value) {
  return inspectionEntries(value).map((entry) => entry.text).join("\n");
}

export function secretCanaryPresent(value) {
  return /contract_secret_canary/i.test(inspectionText(value));
}

export function absolutePathPresent(value) {
  return inspectionEntries(value).some(({ key, text }) => {
    if (key === "paths" && /^\/(?:[^/]+\/?)+$/.test(text)) return false;
    return /(?:^|[\s"'(])\/(?!\/)/.test(text)
      || /(?:^|[\s"'(])[a-z]:[\\/]/i.test(text)
      || /(?:^|[\s"'(])\\\\[^\\]+\\/.test(text);
  });
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
