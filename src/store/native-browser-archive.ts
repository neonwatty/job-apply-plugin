import { browserArchiveCheck, browserArchiveSegmentCodeUnitLimit, browserArchiveSegmentLimit } from '../contracts/workspace/browser-operation-archive.js';
import { BrowserBoundaryError } from '../contracts/workspace/browser-boundary.js';
import { browserOperationLimit, unresolvedBrowserOperation, validateBrowserOperationLedger } from '../contracts/workspace/browser-operations.js';
import type { BrowserOperation, BrowserOperationLedger } from '../contracts/workspace/browser-operations.js';
import type { BrowserOperationArchiveService, BrowserOperationHistory } from '../integrations/browser/durable-contract.js';
import { NativeBrowserArchiveFiles, archiveDigest } from './native-browser-archive-files.js';

const copy = <T>(value: T): T => structuredClone(value);
const references = (ledger: BrowserOperationLedger) => ledger.schemaVersion === 2 ? ledger.archive.segments : [];

/** The caller owns the canonical Store lock. Preparation never publishes or grants new authority. */
export class NativeBrowserArchive implements BrowserOperationArchiveService {
  private readonly files: NativeBrowserArchiveFiles;
  constructor(rootPath: string, checkpoint: (stage: string) => Promise<void> = async () => {}) {
    this.files = new NativeBrowserArchiveFiles(rootPath, checkpoint);
  }
  private async load(value: BrowserOperationLedger): Promise<BrowserOperationHistory> {
    try {
      const ledger = validateBrowserOperationLedger(value), refs = references(ledger);
      await this.files.inventory(refs.length > 0);
      const operations = new Map<string, BrowserOperation>();
      const merge = (stored: BrowserOperationLedger, archived: boolean) => {
        for (const [id, operation] of Object.entries(stored.operations)) {
          browserArchiveCheck(!operations.has(id) && (!archived || !unresolvedBrowserOperation(operation)));
          operations.set(id, copy(operation));
        }
      };
      for (const reference of refs) {
        const bytes = await this.files.read(reference.digest), text = bytes.toString('utf8');
        browserArchiveCheck(text.length <= browserArchiveSegmentCodeUnitLimit && Buffer.from(text).equals(bytes));
        const segment = JSON.parse(text) as Record<string, unknown>;
        browserArchiveCheck(segment !== null && typeof segment === 'object' && !Array.isArray(segment)
          && Object.keys(segment).sort().join(',') === 'ledger,schemaVersion' && segment.schemaVersion === 1);
        const stored = validateBrowserOperationLedger(segment.ledger);
        browserArchiveCheck(stored.schemaVersion === 1 && Object.keys(stored.operations).length === reference.operationCount);
        merge(stored, true);
      }
      // Even identical copies conflict: an operation has exactly one retained location.
      merge(ledger, false);
      return { operation: id => copy(operations.get(id) ?? null) };
    } catch { throw new BrowserBoundaryError('invalid_browser_state'); }
  }
  async validate(ledger: BrowserOperationLedger): Promise<void> { await this.load(ledger); }
  async prepare(value: BrowserOperationLedger): ReturnType<BrowserOperationArchiveService['prepare']> {
    const ledger = validateBrowserOperationLedger(copy(value)), history = await this.load(ledger);
    const refs = references(ledger);
    const unchanged = { ledger, history, flush: async () => {} };
    if (refs.length >= browserArchiveSegmentLimit) return unchanged;
    const pressure = Object.keys(ledger.operations).length >= browserOperationLimit - 1
      || JSON.stringify(ledger).length > 768 * 1024;
    if (!pressure) return unchanged;
    const terminal = Object.fromEntries(Object.entries(ledger.operations).filter(([, item]) => !unresolvedBrowserOperation(item)));
    const operationCount = Object.keys(terminal).length;
    if (operationCount === 0) return unchanged;
    const segmentLedger = validateBrowserOperationLedger({ schemaVersion: 1, operations: terminal });
    const bytes = JSON.stringify({ schemaVersion: 1, ledger: segmentLedger });
    browserArchiveCheck(bytes.length <= browserArchiveSegmentCodeUnitLimit);
    const digest = archiveDigest(bytes);
    const next = validateBrowserOperationLedger({ schemaVersion: 2,
      operations: Object.fromEntries(Object.entries(ledger.operations).filter(([, item]) => unresolvedBrowserOperation(item))),
      archive: { schemaVersion: 1, segments: [...refs, { digest, operationCount }] } });
    let flushed = false;
    return { ledger: next, history, flush: async () => {
      if (flushed) return;
      const actual = await this.files.publish(bytes, refs.map(item => item.digest));
      browserArchiveCheck(actual === digest);
      flushed = true;
    } };
  }
}
