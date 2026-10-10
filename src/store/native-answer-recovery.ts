import { NativeClaimJournal, claimOperationKinds, validateClaimJournal } from './native-claim-journal.js';
import { NativeClaimHistory } from './native-claim-history.js';
import { NativeAnswerJournal, answerJournalName } from './native-answer-journal.js';
import { NativeAnswerResolutionJournal } from './native-answer-resolution-journal.js';
import { validateCoordinator } from '../contracts/workspace/claims.js';
import { validateJobsDocument } from '../contracts/workspace/jobs.js';
import { validateAnswers } from '../contracts/workspace/answers.js';
import { get, object, string, JobsError } from '../contracts/workspace/values.js';
import type { Document } from '../contracts/workspace/values.js';

export async function recoverNativeAnswers(storage: {
  journal(name: string): Promise<Document>; document(name: string): Promise<Document>;
  sessions(): Promise<Document[]>; history: NativeClaimHistory;
  claimJournal: NativeClaimJournal; resolutionJournal: NativeAnswerResolutionJournal; answerJournal: NativeAnswerJournal;
}): Promise<void> {
    const coordinator = validateCoordinator(await storage.journal('coordinator'));
    const sessions = await storage.sessions();
    const journal = await storage.journal(answerJournalName), operation = get(journal,'operation');
    if (operation !== null && claimOperationKinds.has(string(get(object(operation,'coordinator operation'),'kind'))!)) {
      validateClaimJournal(journal);
      await storage.history.repairPendingTail();
      await storage.claimJournal.recover(journal,validateJobsDocument(await storage.document('jobs')));
      return;
    }
    await storage.history.read();
    if (operation !== null && get(coordinator,'claim') !== null) throw new JobsError('answer recovery requires an idle coordinator');
    if (operation !== null && string(get(object(operation,'coordinator operation'),'kind')) === 'answer_resolution') {
      await storage.resolutionJournal.recover(journal,validateJobsDocument(await storage.document('jobs')),sessions);
    } else await storage.answerJournal.recover(journal,validateAnswers(await storage.document('answers')),sessions);
}
