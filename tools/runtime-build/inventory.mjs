import fs from "node:fs/promises";
import path from "node:path";

export const MAX_LINES = 500;

export function physicalLines(bytes) {
  if (bytes.length === 0) return 0;
  return [...bytes].filter((byte) => byte === 10).length + (bytes.at(-1) === 10 ? 0 : 1);
}

export async function inventory(directory, { optional = false } = {}) {
  const files = new Map();
  async function visit(current, relative = "") {
    let entries;
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("build directory must be a real directory");
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (optional && !relative && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("build inventory rejects symlinks");
      if (entry.isDirectory()) await visit(absolute, name);
      else if (entry.isFile()) files.set(name, await fs.readFile(absolute));
      else throw new Error("build inventory rejects special files");
    }
  }
  await visit(directory);
  return files;
}

export function validateModules(sources, outputs) {
  if (sources.size === 0) throw new Error("TypeScript source inventory is empty");
  const expected = new Set();
  for (const [name, bytes] of sources) {
    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) throw new Error("source inventory requires implementation .ts modules");
    if (physicalLines(bytes) > MAX_LINES) throw new Error("TypeScript source exceeds 500 physical lines");
    expected.add(name.replace(/\.ts$/, ".js"));
  }
  if (expected.size !== outputs.size || [...outputs.keys()].some((name) => !expected.has(name))) {
    throw new Error("runtime must contain exactly one JavaScript module per TypeScript source");
  }
  for (const bytes of outputs.values()) {
    if (physicalLines(bytes) > MAX_LINES) throw new Error("compiled runtime exceeds 500 physical lines");
    if (bytes.includes(Buffer.from("sourceMappingURL="))) throw new Error("runtime source maps are not permitted");
  }
}
