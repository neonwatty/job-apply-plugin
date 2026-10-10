import type { Document, Value } from './values.js';
import type { ExtractionTransaction } from '../../workspace-core/extraction-context.js';

export interface ResumeExtractionDomain {
  snapshot: ExtractionTransaction;
  create(resumeId: string, revision: bigint): Promise<Document>;
  propose(requestId: string, revision: bigint, candidate: Value): Promise<Document>;
  confirm(resumeId: string, revision: bigint, contentRevision: string): Promise<Document>;
  close(requestId: string, revision: bigint, interrupted: boolean): Promise<Document>;
}
