import { fromJSON, object } from '../contracts/workspace/values.js';
import { validateSettingsDocument } from '../contracts/workspace/automation.js';
import { validateAccountsDocument } from '../contracts/workspace/accounts.js';
export function initialAutomationDocuments(now) {
    return {
        'automation-settings': object(fromJSON({ schemaVersion: 1, settings: { enabled: false,
                automaticAccountCreation: false, signupEmail: null, passwordStrategy: 'unique_per_realm',
                revision: 1, createdAt: now, updatedAt: now } }), 'automation settings'),
        'employer-accounts': object(fromJSON({ schemaVersion: 1, accounts: {}, metadata: { createdAt: now, updatedAt: now } }), 'employer accounts'),
    };
}
/** No root adoption, implicit initialization, credentials, or recovery execution. */
export async function automationTransaction(access, operation) {
    return operation({
        loadSettings: () => access.read('automation-settings'),
        loadAccounts: () => access.read('employer-accounts'),
        loadProfile: () => access.read('profile'),
        saveSettings: document => access.write('automation-settings', validateSettingsDocument(document)),
        saveAccounts: document => access.write('employer-accounts', validateAccountsDocument(document)),
    });
}
/** Factory lets the owner supply the existing root/lock boundary unchanged. */
export function createAutomationRepository(locked) {
    return { automationTransaction: operation => locked(access => automationTransaction(access, operation)) };
}
