import { randomUUID } from "node:crypto";
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
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, absolute);
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}
