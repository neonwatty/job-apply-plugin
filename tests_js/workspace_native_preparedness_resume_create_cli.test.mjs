import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, serialize } from '../runtime/contracts/workspace/values.js';
import { PreparednessService } from '../runtime/workspace-core/profile-preparedness.js';
import { runNativeStoreStateCommand } from '../runtime/cli/native-store-state.js';

const value = input => parse(JSON.stringify(input));
const plain = input => JSON.parse(serialize(input));

test('preparedness returns ordered value-free setup, coverage, and review health', async () => {
  const repository = { preparednessSnapshot: async () => ({
    profile: value({ firstName: 'Private', lastName: ' ', email: 'private@example.invalid', skills: ['Private skill'] }),
    provenance: value({ '/firstName': { source: 'user', updatedAt: 'x' } }),
    resumes: [{ id: 'resume-private', default: true, deletedAt: null, storageKind: 'managed', digest: 'secret-digest' }],
    observeResume: async () => ({ exists: true, digest: 'secret-digest' }),
    requests: [{ status: 'failed', resumeId: 'resume-private', requestId: 'request-1', failureReason: 'interrupted' }],
    proposals: [{ status: 'pending', resumeId: 'resume-private', id: 'proposal-1', pendingPaths: ['/firstName'] }],
  }) };
  const result = plain(await new PreparednessService(repository).get());
  assert.deepEqual(result.essentialSetup.map(item => [item.id, item.state]), [
    ['first_name', 'present'], ['last_name', 'blocked'], ['email', 'present'], ['default_resume', 'present'],
  ]);
  assert.equal(result.commonCoverage.find(item => item.id === 'skills').state, 'present');
  assert.deepEqual(result.reviewHealth.map(item => item.reasonCode), [
    'extraction_failed', 'human_protected_facts_retained', 'unresolved_conflicts',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private@example|secret-digest|Private skill/);
});

test('preparedness protects both ancestors and descendants of human provenance', async () => {
  const repository = { preparednessSnapshot: async () => ({
    profile: value({}), provenance: value({ '/workHistory/0/company': { source: 'user', updatedAt: 'x' } }),
    resumes: [], observeResume: async () => ({ exists: false, digest: null }), requests: [],
    proposals: [{ status: 'pending', resumeId: 'resume', id: 'proposal', pendingPaths: ['/workHistory'] }],
  }) };
  const result = plain(await new PreparednessService(repository).get());
  assert.ok(result.reviewHealth.some(item => item.reasonCode === 'human_protected_facts_retained'));
});

test('resume-create preserves the source filename and removes the embedded path before import', async () => {
  let imported;
  const repository = {
    historyTransaction: async () => { throw new Error('unused'); },
    sessionTransaction: async () => { throw new Error('unused'); },
    preparednessSnapshot: async () => { throw new Error('unused'); },
    resumeImport: async (metadata, filename, content, preserveFilename) => {
      imported = { metadata: plain(metadata), filename, content: content.toString(), preserveFilename };
      return value({ id: 'resume-1' });
    },
  };
  const context = {
    repository,
    readInput: async () => value({ id: 'resume-1', label: 'Resume', path: '/private/My Resume.pdf' }),
    readResumePath: async path => { assert.equal(path, '/private/My Resume.pdf'); return Buffer.from('pdf'); },
  };
  assert.deepEqual(plain(await runNativeStoreStateCommand('resume-create', ['--input', '-'], context)), { id: 'resume-1' });
  assert.deepEqual(imported, {
    metadata: { id: 'resume-1', label: 'Resume' }, filename: 'My Resume.pdf', content: 'pdf', preserveFilename: true,
  });
});
