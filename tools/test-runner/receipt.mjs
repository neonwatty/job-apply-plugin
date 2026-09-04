import fs from "node:fs/promises";
import path from "node:path";

export function buildReceipt(selection, results) {
  return {
    schemaVersion: 1,
    baseSha: selection.baseSha ?? null,
    headSha: selection.headSha ?? null,
    changedPaths: selection.changedPaths ?? [],
    selectedSuites: selection.suiteIds,
    fallbackReason: selection.fallbackReason ?? null,
    timings: results.map(({ id, durationMs, status }) => ({ id, durationMs, status })),
    status: results.some((result) => result.status === "failed") ? "failed" : "passed",
  };
}

export async function writeReceipt(root, destination, receipt) {
  const absolute = path.resolve(root, destination);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}
