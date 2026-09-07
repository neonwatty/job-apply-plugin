import { PythonText } from "./python-text.js";

const contentKey = PythonText.prototype.contentKey;

/** Content-keyed storage; values remain opaque and retain their original identity. */
export class PythonObject<V> {
  readonly #items = new Map<string, { key: PythonText; value: V }>();

  get size(): number { return this.#items.size; }

  has(key: PythonText): boolean { return this.#items.has(contentKey.call(key)); }

  get(key: PythonText): V | undefined;
  get<D>(key: PythonText, fallback: D): V | D;
  get<D>(key: PythonText, fallback?: D): V | D | undefined {
    const entry = this.#items.get(contentKey.call(key));
    return entry === undefined ? fallback : entry.value;
  }

  set(key: PythonText, value: V): this {
    const identity = contentKey.call(key);
    const existing = this.#items.get(identity);
    if (existing === undefined) this.#items.set(identity, { key, value });
    else existing.value = value;
    return this;
  }

  delete(key: PythonText): boolean { return this.#items.delete(contentKey.call(key)); }

  /** A structural snapshot, not a Python live dictionary view. */
  entries(): ReadonlyArray<readonly [PythonText, V]> {
    return Object.freeze(Array.from(this.#items.values(), ({ key, value }) =>
      Object.freeze([key, value] as const)));
  }

  toJSON(): never { throw new TypeError("PythonObject requires explicit JSON serialization"); }
}
