import os from "node:os";
import { runStreaming } from "./process.mjs";
import { suiteFiles } from "./matrix.mjs";

export function pythonExecutable(platform = process.platform) {
  return platform === "win32" ? "python" : "python3";
}

export function suiteCommand(suite, tracked, platform = process.platform) {
  if (suite.kind === "command") return suite.command;
  const files = suiteFiles(suite, tracked);
  if (suite.kind === "node-test") return [process.execPath, "--test", ...files];
  const modules = files.map((file) => file.replaceAll("/", ".").replace(/\.py$/, ""));
  return [pythonExecutable(platform), "-m", "unittest", "-v", ...modules];
}

export async function executeSuites(root, suites, tracked, options = {}) {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? Math.min(4, os.cpus().length), suites.length || 1));
  const run = options.run ?? runStreaming;
  const results = new Array(suites.length);
  let cursor = 0;
  async function worker() {
    while (cursor < suites.length) {
      const index = cursor++;
      const suite = suites[index];
      if (suite.platforms && !suite.platforms.includes(process.platform)) {
        results[index] = { id: suite.id, status: "skipped", durationMs: 0 };
        continue;
      }
      const [executable, ...args] = suiteCommand(suite, tracked);
      results[index] = {
        id: suite.id,
        ...await run(executable, args, {
          cwd: root,
          env: { ...process.env, ...(suite.env ?? {}) },
          label: suite.id,
          stdout: options.stdout,
          stderr: options.stderr,
        }),
      };
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
