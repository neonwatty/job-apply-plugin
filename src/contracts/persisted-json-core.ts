import { validatePathProfile } from "./posix-path.js";
import type { PythonPathProfile } from "./posix-path.js";

export interface PersistenceOptions {
  pathProfile: PythonPathProfile;
  intMaxStrDigits: number;
}
export interface PersistenceText<T> {
  literal(ascii: string): T;
  concat(parts: readonly T[]): T;
}
export interface PersistenceValueAdapter<V, T> {
  scalar(value: V): T | undefined;
  array(value: V): { identity: object; items: readonly V[] } | undefined;
  object(value: V): {
    identity: object;
    empty: boolean;
    sortedEntries(): ReadonlyArray<{ key: T; readValue(): V }>;
  } | undefined;
  unsupported(value: V): never;
  circular(): never;
}

/** Shared lazy traversal; adapters retain their own value and text representation. */
export function* iterPersistence<V, T>(
  value: V,
  options: PersistenceOptions,
  text: PersistenceText<T>,
  adapter: PersistenceValueAdapter<V, T>,
  compact = false,
): Generator<T> {
  validatePathProfile(options.pathProfile);
  if (!Number.isSafeInteger(options.intMaxStrDigits) || options.intMaxStrDigits < 0
    || options.intMaxStrDigits > 0 && options.intMaxStrDigits < 640) {
    throw new RangeError("intMaxStrDigits must be zero or an integer of at least 640");
  }
  const active = new Set<object>();
  function* encode(item: V, depth: number): Generator<T> {
    const primitive = adapter.scalar(item);
    if (primitive !== undefined) {
      yield primitive;
      return;
    }
    const array = adapter.array(item);
    const object = array === undefined ? adapter.object(item) : undefined;
    if (array === undefined && object === undefined) return adapter.unsupported(item);
    if (array !== undefined ? array.items.length === 0 : object!.empty) {
      yield text.literal(array === undefined ? "{}" : "[]");
      return;
    }
    const identity = (array ?? object)!.identity;
    if (active.has(identity)) return adapter.circular();
    active.add(identity);
    const indent = compact ? "" : "\n" + "  ".repeat(depth + 1);
    if (array !== undefined) {
      for (let index = 0; index < array.items.length; index += 1) {
        const prefix = text.literal((index ? compact ? ", " : "," : "[") + indent);
        const child = adapter.scalar(array.items[index]!);
        if (child !== undefined) yield text.concat([prefix, child]);
        else {
          yield prefix;
          // Preserve the original indexed read after the caller resumes the iterator.
          yield* encode(array.items[index]!, depth + 1);
        }
      }
      if (!compact) yield text.literal("\n" + "  ".repeat(depth));
      yield text.literal("]");
    } else {
      yield text.literal("{");
      if (!compact && options.pathProfile === "3.12") yield text.literal(indent);
      const entries = object!.sortedEntries();
      for (let index = 0; index < entries.length; index += 1) {
        if (index > 0) yield text.literal(compact ? ", " : "," + indent);
        else if (!compact && options.pathProfile !== "3.12") yield text.literal(indent);
        const entry = entries[index]!;
        yield entry.key;
        yield text.literal(": ");
        yield* encode(entry.readValue(), depth + 1);
      }
      if (!compact) yield text.literal("\n" + "  ".repeat(depth));
      yield text.literal("}");
    }
    active.delete(identity);
  }
  yield* encode(value, 0);
}
