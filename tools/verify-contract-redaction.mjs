#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { redactionViolations, validateCorpus } from "./contracts/vector-format.mjs";

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: "invalid_invocation" })}\n`);
    return 2;
  }
  try {
    for (const path of argv) {
      const text = await readFile(path, "utf8");
      if (redactionViolations(text)) throw new Error();
      validateCorpus(JSON.parse(text));
    }
    process.stdout.write(`${JSON.stringify({ ok: true, checked: argv.length })}\n`);
    return 0;
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, error: "contract_redaction_failed" })}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
