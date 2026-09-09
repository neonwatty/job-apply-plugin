import { linkLegacyContext } from "../contracts/persistence-exception.js";
import type { ContextLinker } from "../contracts/persistence-exception.js";
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

/** Caller supplies domain idempotency and holds the transaction lock. */
export async function appendHistoryEvent(
  path: string,
  event: PythonJson,
  options: AppendHistoryOptions,
): Promise<void> {
  return appendHistoryEventFor(path, event, item => options.isIdempotent(item),
    () => encodeJsonlJson(event, options.serialization),
    () => options.io ?? createNativeJsonlHistoryIO(options.serialization.pathProfile), linkLegacyContext);
}

/** Gate and serialization complete before even selecting a native IO adapter. */
export async function appendHistoryEventFor<V>(
  path: string,
  event: V,
  isIdempotent: (event: V) => Promise<boolean>,
  serialize: () => Buffer,
  getIO: () => JsonlHistoryIO,
  linkContext: ContextLinker,
): Promise<void> {
  if (await isIdempotent(event)) return;
  const encoded = serialize();
  const io = getIO();
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
      failure = linkContext(rollbackError, error);
      throw failure;
    }
    throw error;
  } finally {
    try { await handle.close(); }
    catch (closeError) { throw linkContext(closeError, failure); }
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
    catch (closeError) { throw linkLegacyContext(closeError, failure); }
  }
}
