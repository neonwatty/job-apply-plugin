import { PythonText } from "./python-text.js";
const contentKey = PythonText.prototype.contentKey;
/** Content-keyed storage; values remain opaque and retain their original identity. */
export class PythonObject {
    #items = new Map();
    get size() { return this.#items.size; }
    has(key) { return this.#items.has(contentKey.call(key)); }
    get(key, fallback) {
        const entry = this.#items.get(contentKey.call(key));
        return entry === undefined ? fallback : entry.value;
    }
    set(key, value) {
        const identity = contentKey.call(key);
        const existing = this.#items.get(identity);
        if (existing === undefined)
            this.#items.set(identity, { key, value });
        else
            existing.value = value;
        return this;
    }
    delete(key) { return this.#items.delete(contentKey.call(key)); }
    /** A structural snapshot, not a Python live dictionary view. */
    entries() {
        return Object.freeze(Array.from(this.#items.values(), ({ key, value }) => Object.freeze([key, value])));
    }
    toJSON() { throw new TypeError("PythonObject requires explicit JSON serialization"); }
}
