import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRuntime } from "../tools/build-runtime.mjs";
import { inventory, physicalLines, validateModules } from "../tools/runtime-build/inventory.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "job-apply-build-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  await fs.copyFile(path.join(ROOT, "tsconfig.json"), path.join(root, "tsconfig.json"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(root, "src/main.ts"), 'export const result: string = "synthetic";\n');
  return root;
}

test("runtime build is reproducible, one-to-one and detects checked-in drift", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "src/leaf"));
  await fs.writeFile(path.join(root, "src/leaf/value.ts"), "export const value = 1;\n");
  assert.deepEqual(await buildRuntime(root), { schemaVersion: 1, mode: "build", modules: 2 });
  const first = await inventory(path.join(root, "runtime"));
  await buildRuntime(root);
  assert.deepEqual(await inventory(path.join(root, "runtime")), first);
  assert.deepEqual([...first.keys()], ["leaf/value.js", "main.js"]);
  await buildRuntime(root, { check: true });
  await fs.appendFile(path.join(root, "runtime/main.js"), "// drift\n");
  await assert.rejects(buildRuntime(root, { check: true }), /runtime differs/);
  assert.match(await fs.readFile(path.join(root, "runtime/main.js"), "utf8"), /drift/);
});

test("type failures and stale files preserve existing runtime bytes", async (t) => {
  const root = await fixture(t);
  await buildRuntime(root);
  const original = await inventory(path.join(root, "runtime"));
  await fs.writeFile(path.join(root, "src/main.ts"), "export const invalid: string = 1;\n");
  await assert.rejects(buildRuntime(root), /compilation failed/);
  assert.deepEqual(await inventory(path.join(root, "runtime")), original);
  await fs.writeFile(path.join(root, "src/main.ts"), "export function identity(value) { return value; }\n");
  await assert.rejects(buildRuntime(root), /compilation failed/);
  assert.deepEqual(await inventory(path.join(root, "runtime")), original);
  await fs.writeFile(path.join(root, "src/main.ts"), 'export const result: string = "synthetic";\n');
  await fs.writeFile(path.join(root, "runtime/stale.js"), "// preserve\n");
  await assert.rejects(buildRuntime(root), /stale or unexpected/);
  assert.equal(await fs.readFile(path.join(root, "runtime/stale.js"), "utf8"), "// preserve\n");
});

test("compiler configuration retains the strict shadow-module boundary", async () => {
  const { compilerOptions: options } = JSON.parse(await fs.readFile(path.join(ROOT, "tsconfig.json"), "utf8"));
  for (const key of ["strict", "noUncheckedIndexedAccess", "exactOptionalPropertyTypes", "noImplicitOverride",
    "noFallthroughCasesInSwitch", "noUnusedLocals", "noUnusedParameters", "verbatimModuleSyntax",
    "isolatedModules", "noEmitOnError", "forceConsistentCasingInFileNames"]) assert.equal(options[key], true, key);
  for (const key of ["sourceMap", "declaration", "removeComments"]) assert.equal(options[key], false, key);
  assert.equal(options.module, "NodeNext");
  assert.equal(options.target, "ES2022");
  assert.equal(options.rootDir, "src");
  assert.equal(options.outDir, "runtime");
});

test("source and emitted physical-line bounds and exact module inventories fail closed", () => {
  assert.equal(physicalLines(Buffer.from("")), 0);
  assert.equal(physicalLines(Buffer.from("one\r\ntwo")), 2);
  const source = new Map([["main.ts", Buffer.from("// source\n")]]);
  const output = new Map([["main.js", Buffer.from("// output\n")]]);
  validateModules(source, output);
  assert.throws(() => validateModules(new Map(), new Map()), /empty/);
  assert.throws(() => validateModules(source, new Map()), /exactly one/);
  assert.throws(() => validateModules(source, new Map([["main.js.map", Buffer.from("{}")]])), /exactly one/);
  assert.throws(() => validateModules(new Map([["main.d.ts", Buffer.from("")]]), output), /implementation/);
  for (const count of [500, 501]) {
    const lines = Buffer.from("// line\n".repeat(count));
    if (count === 500) validateModules(new Map([["main.ts", lines]]), new Map([["main.js", lines]]));
    else {
      assert.throws(() => validateModules(new Map([["main.ts", lines]]), output), /source exceeds/);
      assert.throws(() => validateModules(source, new Map([["main.js", lines]])), /runtime exceeds/);
    }
  }
  assert.throws(() => validateModules(source, new Map([["main.js", Buffer.from("//# sourceMappingURL=main.js.map")]])), /source maps/);
});

test("inventory rejects symlink roots and entries without writing through them", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "foreign"));
  await fs.writeFile(path.join(root, "foreign/keep.js"), "// original\n");
  await fs.symlink(path.join(root, "foreign"), path.join(root, "runtime"), "junction");
  await assert.rejects(buildRuntime(root), /real directory/);
  assert.equal(await fs.readFile(path.join(root, "foreign/keep.js"), "utf8"), "// original\n");
  await fs.symlink(path.join(root, "foreign"), path.join(root, "src/linked"), "junction");
  await assert.rejects(inventory(path.join(root, "src")), /rejects symlinks/);
});

test("repository runtime is current and remains an inert shadow sentinel", async () => {
  await buildRuntime(ROOT, { check: true });
  const { migrationAuthority } = await import("../runtime/foundation.js");
  assert.deepEqual(migrationAuthority, { schemaVersion: 1, mode: "shadow-only", canonicalWriter: "python" });
  assert.equal(Object.isFrozen(migrationAuthority), true);
});
