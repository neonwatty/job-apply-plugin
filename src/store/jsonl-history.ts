import { constants } from "node:fs";
import { encodeJsonlJson } from "../contracts/jsonl-json.js";
import type { PersistedJsonOptions } from "../contracts/persisted-json.js";
import type { PythonJson } from "../contracts/raw-json/value.js";
import { constructPosixPath } from "../contracts/posix-path.js";
import type { PythonPathProfile } from "../contracts/posix-path.js";
import { createNativeJsonlHistoryIO } from "./jsonl-history-io.js";
import type { JsonlHistoryIO } from "./jsonl-history-io.js";
import { StoreValidationError } from "./validation.js";

export interface AppendHistoryOptions {
  isIdempotent(event: PythonJson): Promise<boolean>;
  serialization: PersistedJsonOptions;
  io?: JsonlHistoryIO;
}
export interface RepairHistoryOptions {
  pendingOperation(): Promise<unknown>;
  pathProfile: PythonPathProfile;
  io?: JsonlHistoryIO;
}
export class HistoryAppendError extends StoreValidationError {
  constructor() {
    super("history append was incomplete");
    this.name = "StoreError";
  }
}

function contextual(error: unknown, previous: unknown): unknown {
  if (error instanceof Error && previous !== undefined && error !== previous && error.cause === undefined) {
    error.cause = previous;
  }
  return error;
}

/** Caller supplies domain idempotency and holds the transaction lock. */
export async function appendHistoryEvent(
  path: string,
  event: PythonJson,
  options: AppendHistoryOptions,
): Promise<void> {
  if (await options.isIdempotent(event)) return;
  const encoded = encodeJsonlJson(event, options.serialization);
  const io = options.io ?? createNativeJsonlHistoryIO(options.serialization.pathProfile);
  path = constructPosixPath("", path);
  const handle = await io.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  // Baseline parity: the initial stat is outside cleanup. Failure does not
  // explicitly close the descriptor; FileHandle GC is not a cleanup receipt.
  const originalSize = (await handle.stat()).size;
  let failure: unknown;
  try {
    let offset = 0;
    while (offset < encoded.length) {
      const written = await handle.write(encoded.subarray(offset));
      if (written <= 0) throw new HistoryAppendError();
      offset += written;
    }
    await handle.sync();
  } catch (error) {
    failure = error;
    try {
      await handle.truncate(originalSize);
      await handle.sync();
    } catch (rollbackError) {
      failure = contextual(rollbackError, error);
      throw failure;
    }
    throw error;
  } finally {
    try { await handle.close(); }
    catch (closeError) { throw contextual(closeError, failure); }
  }
  await io.chmod(path, 0o600);
}

/** Repair only a pending operation's final unterminated byte suffix. */
export async function repairPendingHistoryTail(path: string, options: RepairHistoryOptions): Promise<void> {
  const operation = await options.pendingOperation();
  if (operation === null) return;
  const io = options.io ?? createNativeJsonlHistoryIO(options.pathProfile);
  path = constructPosixPath("", path);
  if (!await io.exists(path)) return;
  const handle = await io.open(path, constants.O_RDWR);
  let failure: unknown;
  try {
    const content = await handle.read((await handle.stat()).size);
    if (content.length === 0 || content[content.length - 1] === 10) return;
    await handle.truncate(BigInt(content.lastIndexOf(10) + 1));
    await handle.sync();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await handle.close(); }
    catch (closeError) { throw contextual(closeError, failure); }
  }
}
