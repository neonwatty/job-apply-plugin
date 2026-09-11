import { validateProfile } from '../contracts/workspace/profile.js';
import { copy, fromJSON, get, has, int, integer, object, parse, serialize, set, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import { optionalEmail, publicSettings, settingsPatch, validateSettings, validateSettingsDocument } from '../contracts/workspace/automation.js';

export interface AutomationTransaction {
  loadSettings(): Promise<Document>;
  loadAccounts(): Promise<Document>;
  loadProfile(): Promise<Document>;
  saveSettings(document: Document): Promise<void>;
  saveAccounts(document: Document): Promise<void>;
}
export interface AutomationRepository {
  automationTransaction<T>(operation: (transaction: AutomationTransaction) => Promise<T>): Promise<T>;
}
export const cloneDocument = (document: Document): Document => object(parse(serialize(document)), 'document');
export class AutomationService {
  constructor(readonly repository: AutomationRepository, private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}
  get(publicView = false): Promise<Document> {
    return this.repository.automationTransaction(async tx => {
      const record = object(get(validateSettingsDocument(await tx.loadSettings()), 'settings'), 'automation settings');
      return cloneDocument(publicView ? publicSettings(record) : record);
    });
  }
  update(value: Value, expectedRevision: bigint, publicView = false): Promise<Document> {
    const patch = settingsPatch(value);
    return this.repository.automationTransaction(async tx => this.save(tx, patch, expectedRevision, publicView));
  }
  copyProfileEmail(profileRevision: bigint, settingsRevision: bigint, publicView = true): Promise<Document> {
    return this.repository.automationTransaction(async tx => {
      const profile = validateProfile(await tx.loadProfile());
      const metadata = object(get(profile, 'metadata'), 'profile metadata');
      if ((has(metadata, 'revision') ? int(get(metadata, 'revision')) : 1n) !== profileRevision) throw new JobsError('profile revision conflict');
      const current = object(get(validateSettingsDocument(await tx.loadSettings()), 'settings'), 'automation settings');
      if (int(get(current, 'revision')) !== settingsRevision) throw new JobsError('automation settings revision conflict');
      const email = optionalEmail(get(object(get(profile, 'profile'), 'profile'), 'email'), 'profile email');
      if (email === null) throw new JobsError('canonical profile email is unavailable');
      const updated = await this.save(tx, set(object(fromJSON({}), 'patch'), 'signupEmail', email), settingsRevision, true);
      return publicView ? updated : set(object(fromJSON({ copied: true }), 'copy result'), 'revision', get(updated, 'revision'));
    });
  }
  private async save(tx: AutomationTransaction, patch: Document, revision: bigint, publicView: boolean): Promise<Document> {
    const document = validateSettingsDocument(await tx.loadSettings()), current = object(get(document, 'settings'), 'automation settings');
    if (int(get(current, 'revision')) !== revision) throw new JobsError('automation settings revision conflict');
    const updated = copy(current);
    for (const [key, value] of patch.entries()) updated.set(key, value);
    if (has(patch, 'signupEmail')) set(updated, 'signupEmail', optionalEmail(get(patch, 'signupEmail'), 'signup email'));
    set(updated, 'revision', integer(revision + 1n));
    set(updated, 'updatedAt', text(this.now()));
    validateSettings(updated);
    await tx.saveSettings(set(copy(document), 'settings', updated));
    return cloneDocument(publicView ? publicSettings(updated) : updated);
  }
}
