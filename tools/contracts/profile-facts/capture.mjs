#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const schema = JSON.parse(await readFile(resolve(REPO,
  "contracts/cli/python-profile-fact-mutations.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true }).compile(schema);
const CANARY = "PROFILE_FACT_SECRET_CANARY_7c923d";

export function validateCorpus(value) {
  // Diagnostics never include rejected data or paths.
  if (!validate(value)) throw new Error("profile_fact_schema_invalid");
  const serialized = JSON.stringify(value);
  if (serialized.includes(CANARY) || /(?:\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\\\)/.test(serialized)) {
    throw new Error("profile_fact_redaction_invalid");
  }
  for (const item of value.cases) {
    if (JSON.stringify(item.expectedWrites) !== JSON.stringify(item.observedWrites)
      || JSON.stringify(item.effects.map((effect) => effect.path)) !== JSON.stringify(item.expectedWrites)
      || item.rejectedStateUnchanged !== (item.exitCode !== 0)
      || (item.exitCode !== 0 && (item.stdout !== "" || item.effects.length !== 0))
      || (item.exitCode === 0 && item.stderr !== "")) throw new Error("profile_fact_effects_invalid");
  }
  return value;
}

export async function captureCorpus() {
  const result = spawnSync(process.env.PYTHON || "python3", ["-I", resolve(HERE, "driver.py")], {
    cwd: REPO, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.stderr !== "") throw new Error("profile_fact_capture_failed");
  try { return validateCorpus(JSON.parse(result.stdout)); }
  catch { throw new Error("profile_fact_capture_invalid"); }
}

export function canonicalCorpus(value) {
  validateCorpus(value);
  // One complete case per physical line keeps reviewed vectors below the size cap.
  return `${JSON.stringify({schemaVersion: value.schemaVersion, corpus: value.corpus, clock: value.clock}, null, 2).slice(0, -2)},\n  "cases": [\n${
    value.cases.map((item) => `    ${JSON.stringify(item)}`).join(",\n")
  }\n  ],\n  "secretCanaryAbsent": true\n}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) throw new Error();
    const destination = resolve(argv[1]);
    const [repo, parent] = await Promise.all([realpath(REPO), realpath(dirname(destination))]);
    const rel = relative(repo, parent);
    if (!(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new Error();
    await writeFile(destination, canonicalCorpus(await captureCorpus()), { flag: "wx", mode: 0o600 });
    process.stdout.write('{"ok":true}\n');
    return 0;
  } catch {
    process.stderr.write('{"ok":false,"error":"profile_fact_capture_failed"}\n');
    return 2;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
