/** Error identity remains extensible so callers can compose exception context. */
export class PythonUnicodeDecodeError extends Error {
  readonly encoding: string;
  readonly start: number;
  readonly end: number;
  readonly reason: string;
  readonly #bytes: Buffer;

  constructor(encoding: string, bytes: Buffer, start: number, end: number, reason: string) {
    const location = end - start === 1
      ? `byte 0x${bytes[start]!.toString(16).padStart(2, "0")} in position ${start}`
      : `bytes in position ${start}-${end - 1}`;
    super(`'${encoding}' codec can't decode ${location}: ${reason}`);
    this.name = "UnicodeDecodeError";
    this.encoding = encoding;
    this.start = start;
    this.end = end;
    this.reason = reason;
    this.#bytes = Buffer.from(bytes);
  }

  get object(): Buffer { return Buffer.from(this.#bytes); }
}
