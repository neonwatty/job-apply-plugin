#!/usr/bin/env node

import { realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { captureReadCorpus } from "./contracts/capture-read-corpus.mjs";
import { captureStartupReadCorpus } from "./contracts/capture-startup-read-corpus.mjs";
import { canonicalStartupCorpus } from "./contracts/startup-vector-format.mjs";
import { canonicalCorpus } from "./contracts/vector-format.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function outputArgument(argv) {
  let corpus = "read";
  let outputValue;
  if (argv.length === 2 && argv[0] === "--output" && argv[1]) outputValue = argv[1];
  else if (argv.length === 4 && argv[0] === "--corpus" && argv[1] === "startup-read"
    && argv[2] === "--output" && argv[3]) {
    corpus = "startup-read";
    outputValue = argv[3];
  } else throw new Error("invalid_invocation");
  const output = resolve(outputValue);
  const [repository, outputParent] = await Promise.all([realpath(REPO_ROOT), realpath(dirname(output))]);
  const withinRepository = relative(repository, outputParent);
  const outsideRepository = withinRepository === ".."
    || withinRepository.startsWith(`..${sep}`)
    || isAbsolute(withinRepository);
  if (!outsideRepository) throw new Error("repository_output_forbidden");
  return { corpus, output };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { corpus, output } = await outputArgument(argv);
    const startup = corpus === "startup-read";
    const value = startup ? await captureStartupReadCorpus() : await captureReadCorpus();
    const text = startup ? canonicalStartupCorpus(value) : canonicalCorpus(value);
    await writeFile(output, text, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      ok: true, corpus: startup ? "python-store-startup-read-v1" : "python-store-read-v1",
    })}\n`);
    return 0;
  } catch (error) {
    const known = new Set(["invalid_invocation", "repository_output_forbidden"]);
    const code = known.has(error?.message) ? error.message : "capture_failed";
    process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
