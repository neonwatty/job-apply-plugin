import { copy, fromJSON, get, int, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import { exact, optionalEmail } from '../contracts/workspace/automation.js';
import { publicAccount, validateAccount, validateAccountsDocument } from '../contracts/workspace/accounts.js';
import { resolveAccountRealm } from '../contracts/workspace/account-realm.js';
import { cloneDocument } from './automation.js';
import type { AutomationRepository, AutomationTransaction } from './automation.js';

export class AccountsService {
  constructor(readonly repository: AutomationRepository, private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}
  resolve(url: unknown): Value { return fromJSON(resolveAccountRealm(url)); }
  list(publicView = false): Promise<Document[]> {
    return this.repository.automationTransaction(async tx => {
      const accounts = object(get(validateAccountsDocument(await tx.loadAccounts()), 'accounts'), 'employer accounts');
      return [...accounts.entries()].sort(([a], [b]) => string(a)! < string(b)! ? -1 : 1)
        .map(([, value]) => this.project(object(value, 'employer account'), publicView));
    });
  }
  get(realmRef: string, publicView = false): Promise<Document | null> {
    return this.repository.automationTransaction(async tx => {
      const value = get(object(get(validateAccountsDocument(await tx.loadAccounts()), 'accounts'), 'employer accounts'), realmRef);
      return value === null ? null : this.project(object(value, 'employer account'), publicView);
    });
  }
  create(url: unknown, email: Value = null, publicView = false): Promise<Document> {
    const realm = resolveAccountRealm(url);
    if (realm.status !== 'resolved') throw new JobsError('employer account realm is unresolved');
    const override = optionalEmail(email, 'signup email override');
    return this.repository.automationTransaction(async tx => {
      const document = validateAccountsDocument(await tx.loadAccounts()), accounts = object(get(document, 'accounts'), 'employer accounts');
      if (get(accounts, realm.realmRef) !== null) throw new JobsError('employer account already exists');
      const now = this.now();
      const record = object(fromJSON({ realmRef: realm.realmRef, adapterId: realm.adapterId, descriptorVersion: realm.descriptorVersion,
        descriptor: realm.descriptor, flowKind: realm.flowKind, credentialRequired: realm.credentialRequired,
        signupEmailOverride: null, providerId: null, credentialRef: null, credentialVersion: null,
        lifecycleState: 'discovered', revision: 1, createdAt: now, updatedAt: now }), 'employer account');
      set(record, 'signupEmailOverride', override);
      await this.save(tx, document, realm.realmRef, record);
      return this.project(record, publicView);
    });
  }
  update(realmRef: string, value: Value, revision: bigint, publicView = false): Promise<Document> {
    const patch = object(value, 'employer account patch');
    exact(patch, ['signupEmailOverride'], 'employer account patch may only change signup email override');
    const override = optionalEmail(get(patch, 'signupEmailOverride'), 'signup email override');
    return this.repository.automationTransaction(async tx => {
      const document = validateAccountsDocument(await tx.loadAccounts()), value = get(object(get(document, 'accounts'), 'employer accounts'), realmRef);
      if (value === null) throw new JobsError('employer account does not exist');
      const current = object(value, 'employer account');
      if (int(get(current, 'revision')) !== revision) throw new JobsError('employer account revision conflict');
      const updated = set(copy(current), 'signupEmailOverride', override);
      set(updated, 'revision', integer(revision + 1n));
      set(updated, 'updatedAt', text(this.now()));
      await this.save(tx, document, realmRef, updated);
      return this.project(updated, publicView);
    });
  }
  private project(record: Document, publicView: boolean): Document { return cloneDocument(publicView ? publicAccount(record) : record); }
  private async save(tx: AutomationTransaction, document: Document, realm: string, record: Document): Promise<void> {
    validateAccount(realm, record);
    const accounts = set(copy(object(get(document, 'accounts'), 'employer accounts')), realm, record);
    const metadata = set(copy(object(get(document, 'metadata'), 'employer account metadata')), 'updatedAt', get(record, 'updatedAt'));
    await tx.saveAccounts(set(set(copy(document), 'accounts', accounts), 'metadata', metadata));
  }
}
