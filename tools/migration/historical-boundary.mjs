import { createEvidenceIO } from './evidence-io.mjs';
import { withSnapshot } from '../local-checks/git.mjs';

// Last independently runnable pre-integration inventory. This is an audit input,
// not a cached passing result: its complete audit runs on every invocation.
export const HISTORICAL_BASE = 'ab6964edb5b3e45d5c6c9578947acb3468dee42b';

export function historicalRecord(path) {
  if (path.startsWith('docs/migration/evidence/')) return true;
  if (!path.startsWith('config/migration/')) return false;
  // Only source/surface inventories and their digest lock describe current code.
  return !/^config\/migration\/(?:source-catalog-[^/]+\.json|[^/]+-surfaces\.json|review-lock\.json)$/.test(path);
}

export async function auditHistoricalBoundary(root, audit, base = HISTORICAL_BASE) {
  const io = await createEvidenceIO(root);
  // Other histories, including unborn repositories, retain the original protocol.
  if (!io.revision(base)) return null;
  const head = io.head();
  if (head === base || !io.ancestor(base, head)) return null;
  if (!io.clean()) throw new Error('Historical audit requires a clean current snapshot');
  for (const change of io.diff(base, head)) {
    if ([change.path, change.oldPath].filter(Boolean).some(historicalRecord)) {
      throw new Error(`Archived migration evidence changed: ${change.path}`);
    }
  }
  const result = await withSnapshot(root, base, async snapshot => {
    const frozen = await createEvidenceIO(snapshot);
    if (frozen.head() !== base || !frozen.clean()) throw new Error('Historical snapshot identity differs');
    return audit(snapshot);
  });
  if (result?.status !== 'inventory-consistent' || !Array.isArray(result.errors) || result.errors.length) {
    throw new Error(`Historical audit failed: ${result?.errors?.join('; ') || 'no successful audit result'}`);
  }
  if (io.head() !== head || !io.clean()) throw new Error('Current snapshot changed during historical audit');
  return { revision: base, status: 'audited', currentAcceptance: 'open' };
}
