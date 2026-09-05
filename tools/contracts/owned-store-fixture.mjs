import { createHash } from "node:crypto";
import {
  lstat, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runStore } from "./python-store.mjs";

const KNOWN_DOCUMENTS = new Set([
  "account-operation-journal.json", "applications.jsonl", "automation-settings.json",
  "coordinator-journal.json", "coordinator.json", "employer-accounts.json",
]);
const CONTRACT_COMMANDS = new Set([
  "automation-settings-get", "claim-status", "employer-account-list",
]);

function known(name) {
  if (!KNOWN_DOCUMENTS.has(name)) throw new Error("fixture_document_forbidden");
  return name;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]),
  );
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

async function treeSnapshot(root, relative = "") {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const snapshot = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (relative === "" && entry.name === ".store.lock") continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const path = join(root, child);
    const link = await lstat(path, { bigint: true });
    if (link.isSymbolicLink()) throw new Error("fixture_contains_unsupported_entry");
    if (entry.isDirectory()) {
      snapshot.push({ path: `${child}/`, kind: "directory" });
      snapshot.push(...await treeSnapshot(root, child));
    } else if (entry.isFile()) {
      const [bytes, metadata] = await Promise.all([readFile(path), stat(path, { bigint: true })]);
      snapshot.push({
        path: child,
        kind: "file",
        digest: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        mtimeNs: String(metadata.mtimeNs),
        mode: Number(metadata.mode & 0o777n),
      });
    } else throw new Error("fixture_contains_unsupported_entry");
  }
  return snapshot;
}

function entryMap(snapshot) {
  return new Map(snapshot.map((entry) => [entry.path, entry]));
}

export function changedPaths(before, after) {
  const left = entryMap(before);
  const right = entryMap(after);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return paths.filter((path) => JSON.stringify(left.get(path)) !== JSON.stringify(right.get(path)));
}

export function fileEffect(path, before, after) {
  const left = entryMap(before).get(path) ?? null;
  const right = entryMap(after).get(path) ?? null;
  if (process.platform !== "win32"
    && [left, right].some((entry) => entry !== null && entry.mode !== 0o600)) {
    throw new Error("fixture_private_mode_changed");
  }
  const project = (entry) => entry && ({
    digest: entry.digest, size: entry.size, modeContract: "private-file-0600-posix",
  });
  return {
    path,
    before: project(left),
    after: project(right),
    mtimeChanged: left === null || right === null || left.mtimeNs !== right.mtimeNs,
  };
}

export async function withOwnedStoreFixture(label, callback) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error("fixture_label_invalid");
  const temporary = await mkdtemp(join(tmpdir(), "job-apply-startup-contracts-"));
  const root = join(temporary, label);
  try {
    const initialized = runStore(root, ["init"]);
    if (initialized.exitCode !== 0 || initialized.stderr !== "" || initialized.nonceCalls !== 0) {
      throw new Error("fixture_initialization_failed");
    }
    const capability = Object.freeze({
      run(args) {
        if (!Array.isArray(args) || args.length !== 1 || !CONTRACT_COMMANDS.has(args[0])) {
          throw new Error("fixture_command_invalid");
        }
        const result = runStore(root, args);
        return {
          ...result,
          stdout: result.stdout.replaceAll(root, "<store-root>"),
          stderr: result.stderr.replaceAll(root, "<store-root>"),
        };
      },
      async omitKnown(names) {
        for (const name of names) await rm(join(root, known(name)), { force: true });
      },
      async seedKnown(name, value) {
        const bytes = Buffer.isBuffer(value) || typeof value === "string"
          ? value : canonicalJson(value);
        await writeFile(join(root, known(name)), bytes, { mode: 0o600 });
      },
      async ageKnown(names) {
        const instant = new Date("2020-01-01T00:00:00Z");
        for (const name of names) await utimes(join(root, known(name)), instant, instant);
      },
      snapshot() { return treeSnapshot(root); },
    });
    return await callback(capability);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
