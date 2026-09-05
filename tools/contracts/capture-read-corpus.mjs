import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXED_CLOCK, commandInventory, runStore } from "./python-store.mjs";
import {
  absolutePathPresent, canonicalCorpus, redactionViolations, secretCanaryPresent,
} from "./vector-format.mjs";

const READ_COMMANDS = [
  "profile-inspect", "profile-preparedness-get", "fact-group-list", "job-list",
  "resume-list", "resume-extraction-request-list", "resume-proposal-list", "history-list",
  "session-list",
];
const SECRET_CANARY = "CONTRACT_SECRET_CANARY_DO_NOT_PUBLISH";

async function fileSnapshot(root, relative = "") {
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (relative === "" && entry.name === ".store.lock") continue;
    const child = join(relative, entry.name);
    if (entry.isDirectory()) snapshot.push(...await fileSnapshot(root, child));
    else if (entry.isFile()) {
      const path = join(root, child);
      const [bytes, metadata] = await Promise.all([readFile(path), stat(path, { bigint: true })]);
      snapshot.push({ path: child, digest: createHash("sha256").update(bytes).digest("hex"), mtimeNs: String(metadata.mtimeNs) });
    } else throw new Error("fixture_contains_unsupported_entry");
  }
  return snapshot;
}

function resultCase(scenario, command, result, storeUnchanged, rejectionImmutability) {
  let stdout = null;
  if (result.stdout !== "") {
    try { stdout = JSON.parse(result.stdout); } catch { throw new Error("python_stdout_invalid"); }
  }
  const item = { scenario, command, args: [command], exitCode: result.exitCode, stdout, stderr: result.stderr, storeUnchanged };
  if (rejectionImmutability) item.rejectionImmutability = rejectionImmutability;
  return item;
}

async function initializedRoot(temporary, name) {
  const root = join(temporary, name);
  const result = runStore(root, ["init"]);
  if (result.exitCode !== 0 || result.stderr !== "") throw new Error("fixture_initialization_failed");
  return root;
}

async function rejectedCase(temporary, scenario, bytes) {
  const root = await initializedRoot(temporary, scenario);
  const profilePath = join(root, "profile.json");
  await writeFile(profilePath, bytes, { mode: 0o600 });
  const beforeBytes = await readFile(profilePath);
  const beforeStat = await stat(profilePath, { bigint: true });
  const beforeStore = await fileSnapshot(root);
  const result = runStore(root, ["profile-inspect"]);
  result.stderr = result.stderr.replaceAll(root, "<store-root>");
  const afterBytes = await readFile(profilePath);
  const afterStat = await stat(profilePath, { bigint: true });
  const afterStore = await fileSnapshot(root);
  return resultCase(scenario, "profile-inspect", result, JSON.stringify(beforeStore) === JSON.stringify(afterStore), {
    bytesUnchanged: beforeBytes.equals(afterBytes),
    mtimeNsUnchanged: beforeStat.mtimeNs === afterStat.mtimeNs,
  });
}

export async function captureReadCorpus() {
  const temporary = await mkdtemp(join(tmpdir(), "job-apply-contracts-"));
  try {
    const commands = commandInventory();
    if (commands.length !== 98 || new Set(commands).size !== 98) throw new Error("public_command_inventory_changed");
    const root = await initializedRoot(temporary, "empty");
    const cases = [];
    for (const command of READ_COMMANDS) {
      const before = await fileSnapshot(root);
      const result = runStore(root, [command]);
      const after = await fileSnapshot(root);
      const unchanged = JSON.stringify(before) === JSON.stringify(after);
      if (!unchanged) throw new Error(`read_mutated_${command}`);
      cases.push(resultCase("initialized-empty", command, result, unchanged));
    }
    cases.push(await rejectedCase(temporary, "corrupt-profile", Buffer.from(`{"profile":"${SECRET_CANARY}"`)));
    cases.push(await rejectedCase(temporary, "future-profile", Buffer.from(JSON.stringify({
      schemaVersion: 999, profile: { private: SECRET_CANARY }, metadata: {},
    }))));
    const corpus = {
      schemaVersion: 1,
      corpus: "python-store-read-v1",
      source: "python-store-cli",
      fixture: { kind: "synthetic-empty-store", clock: FIXED_CLOCK, noncePolicy: "not-used-by-captured-reads" },
      inventory: { total: commands.length, commands, captured: READ_COMMANDS, pending: commands.length - READ_COMMANDS.length },
      cases,
      redaction: {
        secretCanaryAbsent: !secretCanaryPresent(cases),
        absolutePathsAbsent: !absolutePathPresent(cases),
        checkedSurfaces: ["stdout", "stderr", "fixture-descriptors", "artifact"],
      },
    };
    if (redactionViolations(corpus)) throw new Error("contract_redaction_failed");
    return JSON.parse(canonicalCorpus(corpus));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
