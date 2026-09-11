import type { Document } from '../contracts/workspace/values.js';
import { fromJSON, object } from '../contracts/workspace/values.js';
import { validateSettingsDocument } from '../contracts/workspace/automation.js';
import { validateAccountsDocument } from '../contracts/workspace/accounts.js';
import type { AutomationRepository, AutomationTransaction } from '../workspace-core/automation.js';

export type AutomationDocumentName = 'automation-settings' | 'employer-accounts';
/** All callbacks run inside the composing repository's validated fixture lock. */
export interface AutomationDocumentAccess {
  read(name: AutomationDocumentName | 'profile'): Promise<Document>;
  write(name: AutomationDocumentName, document: Document): Promise<void>;
}
export function initialAutomationDocuments(now: string): Record<AutomationDocumentName, Document> {
  return {
    'automation-settings': object(fromJSON({ schemaVersion: 1, settings: { enabled: false,
      automaticAccountCreation: false, signupEmail: null, passwordStrategy: 'unique_per_realm',
      revision: 1, createdAt: now, updatedAt: now } }), 'automation settings'),
    'employer-accounts': object(fromJSON({ schemaVersion: 1, accounts: {}, metadata: { createdAt: now, updatedAt: now } }), 'employer accounts'),
  };
}
/** No root adoption, implicit initialization, credentials, or recovery execution. */
export async function automationTransaction<T>(access: AutomationDocumentAccess,
  operation: (transaction: AutomationTransaction) => Promise<T>): Promise<T> {
  return operation({
    loadSettings: () => access.read('automation-settings'),
    loadAccounts: () => access.read('employer-accounts'),
    loadProfile: () => access.read('profile'),
    saveSettings: document => access.write('automation-settings', validateSettingsDocument(document)),
    saveAccounts: document => access.write('employer-accounts', validateAccountsDocument(document)),
  });
}
/** Factory lets the owner supply the existing root/lock boundary unchanged. */
export function createAutomationRepository(
  locked: <T>(operation: (access: AutomationDocumentAccess) => Promise<T>) => Promise<T>,
): AutomationRepository {
  return { automationTransaction: operation => locked(access => automationTransaction(access, operation)) };
}
