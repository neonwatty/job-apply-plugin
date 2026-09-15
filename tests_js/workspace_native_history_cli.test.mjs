import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, serialize } from '../runtime/contracts/workspace/values.js';
import { HistoryService } from '../runtime/workspace-core/store-history.js';
import { nativeStoreStateCommandNames, runNativeStoreStateCommand } from '../runtime/cli/native-store-state.js';

const value = input => parse(JSON.stringify(input));
const plain = input => JSON.parse(serialize(input));

class HistoryRepository {
  events = [];
  answers = new Set(['answer_1']);
  async historyTransaction(operation) {
    return operation({
      read: async () => this.events,
      answerExists: async key => this.answers.has(key),
      append: async event => { this.events.push(event); },
    });
  }
}

function python(command, input) {
  const root = mkdtempSync(join(tmpdir(), 'history-python-'));
  try {
    const result = spawnSync('python3.12', ['scripts/job-apply-store.py', ...command], {
      cwd: process.cwd(), env: { ...process.env, JOB_APPLY_STORE_DIR: root },
      input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('history append creates the closed value-free event and resolves answer keys', async () => {
  const repository = new HistoryRepository();
  const service = new HistoryService(repository, () => '2026-09-15T12:00:00Z', () => 'event-id');
  const event = plain(await service.append(value({
    applicationId: 'job-1', event: 'reviewed', company: 'Private Corp', answerKeys: ['answer_1'],
  })));
  assert.deepEqual(event, {
    schemaVersion: 1, eventId: 'event-id', at: '2026-09-15T12:00:00Z',
    applicationId: 'job-1', event: 'reviewed', company: 'Private Corp', answerKeys: ['answer_1'],
  });
  assert.equal(repository.events.length, 1);
  await assert.rejects(service.append(value({ applicationId: 'job-1', event: 'future-event' })), /unsupported/);
  await assert.rejects(service.append(value({ applicationId: 'job-1', event: 'reviewed', answerKeys: ['missing'] })), /existing answer/);
});

test('history list accepts future value-free event names but rejects malformed persisted records', async () => {
  const repository = new HistoryRepository();
  repository.events.push(value({ schemaVersion: 1, eventId: 'future', at: '2026-09-15T12:00:00Z',
    applicationId: 'job-1', event: 'future-event', answerKeys: [] }));
  assert.equal(plain(await new HistoryService(repository).list())[0].event, 'future-event');
  repository.events.push(value({ schemaVersion: 1, eventId: 'bad', at: 'x', applicationId: 'job-1', event: 'BAD', answerKeys: [] }));
  await assert.rejects(new HistoryService(repository).list(), /history event type is invalid/);
});

test('history append shape matches the CPython 3.12 oracle', async () => {
  const input = { applicationId: 'job-1', event: 'reviewed', answerKeys: [] };
  const expected = python(['history-append', '--input', '-'], input);
  const actual = plain(await new HistoryService(new HistoryRepository(), () => expected.at, () => expected.eventId).append(value(input)));
  assert.deepEqual(actual, expected);
});

test('CLI exposes the closed state command set and normalizes input failures', async () => {
  assert.deepEqual([...nativeStoreStateCommandNames], [
    'history-append', 'history-list', 'profile-preparedness-get', 'resume-create',
    'session-save', 'session-load', 'session-list', 'session-delete',
  ]);
  const repository = new HistoryRepository();
  const context = { repository, readInput: async () => { throw new Error('private path'); } };
  assert.equal(await runNativeStoreStateCommand('job-list', [], context), null);
  await assert.rejects(runNativeStoreStateCommand('history-append', ['--input', '-'], context), /input is not a readable JSON object/);
  await assert.rejects(runNativeStoreStateCommand('history-list', ['--unknown', 'x'], context), /unsupported native Store state command or option/);
});
