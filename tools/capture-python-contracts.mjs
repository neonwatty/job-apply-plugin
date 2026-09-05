#!/usr/bin/env node

import { realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { captureReadCorpus } from "./contracts/capture-read-corpus.mjs";
import { canonicalCorpus } from "./contracts/vector-format.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function outputArgument(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) throw new Error("invalid_invocation");
  const output = resolve(argv[1]);
  const [repository, outputParent] = await Promise.all([realpath(REPO_ROOT), realpath(dirname(output))]);
  const withinRepository = relative(repository, outputParent);
  const outsideRepository = withinRepository === ".."
    || withinRepository.startsWith(`..${sep}`)
    || isAbsolute(withinRepository);
  if (!outsideRepository) throw new Error("repository_output_forbidden");
  return output;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const output = await outputArgument(argv);
    await writeFile(output, canonicalCorpus(await captureReadCorpus()), { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, corpus: "python-store-read-v1" })}\n`);
    return 0;
  } catch (error) {
    const known = new Set(["invalid_invocation", "repository_output_forbidden"]);
    const code = known.has(error?.message) ? error.message : "capture_failed";
    process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
