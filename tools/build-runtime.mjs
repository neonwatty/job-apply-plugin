import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inventory, validateModules } from "./runtime-build/inventory.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPILER = path.join(ROOT, "node_modules/typescript/bin/tsc");

export async function buildRuntime(root = ROOT, { check = false } = {}) {
  const sources = await inventory(path.join(root, "src"));
  const existing = await inventory(path.join(root, "runtime"), { optional: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "job-apply-ts-build-"));
  try {
    const output = path.join(temporary, "modules");
    const compiled = spawnSync(process.execPath, [
      COMPILER, "--project", path.join(root, "tsconfig.json"), "--outDir", output,
      "--incremental", "false", "--pretty", "false",
    ], { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
    if (compiled.error || compiled.status !== 0) {
      throw new Error("TypeScript compilation failed; run npm run typecheck for compiler diagnostics");
    }
    const emitted = await inventory(output);
    validateModules(sources, emitted);
    if ([...existing.keys()].some((name) => !emitted.has(name))) {
      throw new Error("runtime contains stale or unexpected files; review them before removal");
    }
    if (check) {
      if (existing.size !== emitted.size || [...emitted].some(([name, bytes]) => !existing.get(name)?.equals(bytes))) {
        throw new Error("checked-in runtime differs from the deterministic build; run npm run build:runtime");
      }
    } else {
      for (const [name, bytes] of emitted) {
        const destination = path.join(root, "runtime", name);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes);
      }
    }
    return { schemaVersion: 1, mode: check ? "check" : "build", modules: emitted.size };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check")) {
      throw new Error("usage: node tools/build-runtime.mjs [--check]");
    }
    console.log(JSON.stringify(await buildRuntime(ROOT, { check: process.argv[2] === "--check" })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
