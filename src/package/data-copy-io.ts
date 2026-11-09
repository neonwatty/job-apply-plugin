/** Contract boundary only. There is deliberately no default native adapter. */
export interface DataCopyReader {
  read(length: number): Promise<Buffer>;
  close(): Promise<void>;
}
export interface DataCopyWriter {
  write(bytes: Buffer): Promise<number>;
  close(): Promise<void>;
}

export type DataCopyAcceleration = "copied" | "give-up";

/** Adapters preserve Python path spelling, OS errors and buffered stream effects. */
export interface DataCopyIO {
  pathRepr(path: string): string;
  /** Includes OSError instances whose errno is absent; excludes arbitrary errors. */
  isOSError(error: unknown): boolean;
  /** Python IsADirectoryError hierarchy membership, not an errno-only heuristic. */
  isDirectoryError(error: unknown): boolean;
  sameFile(source: string, target: string): Promise<boolean>;
  stat(path: string): Promise<{ isFIFO(): boolean }>;
  isLink(path: string): Promise<boolean>;
  readLink(path: string): Promise<string>;
  symlink(link: string, target: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  openSource(path: string): Promise<DataCopyReader>;
  /** Open with truncation and creation mode 0666 filtered by the actual umask. */
  openTarget(path: string): Promise<DataCopyWriter>;
  /** An optional single accelerator; give-up preserves its current stream state. */
  accelerate?(source: DataCopyReader, target: DataCopyWriter): Promise<DataCopyAcceleration>;
}
