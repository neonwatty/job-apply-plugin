import assert from 'node:assert/strict';
import test from 'node:test';
import { agentArguments, execute, parseTrace, validateContext } from '../evals/preparation/support.mjs';
import { removeReviewedPreparationEvalMatrixAdditions } from './point_paths_domain_support.mjs';

const lines = (...events) => events.map(event => JSON.stringify(event)).join('\n');
test('historical matrix comparison removes only the exact evaluation registration', () => {
  const owner = { paths: ['evals/preparation/*.mjs'], suites: ['node-runner-fast'] };
  const before = { inventory: { include: ['before', 'evals/**/*.mjs', 'after'] },
    ownership: [{ paths: ['untouched'], suites: ['original'] }, owner] };
  const matrix = structuredClone(before);
  removeReviewedPreparationEvalMatrixAdditions(matrix);
  assert.deepEqual(matrix, { inventory: { include: ['before', 'after'] },
    ownership: [{ paths: ['untouched'], suites: ['original'] }] });
  for (const mutate of [m => m.inventory.include.push('evals/**/*.mjs'),
    m => m.inventory.include.splice(1, 1), m => m.ownership.push(owner),
    m => m.ownership.pop(), m => m.ownership[1].suites.push('unreviewed'),
    m => m.ownership[1].paths.push('unreviewed')]) {
    const invalid = structuredClone(before);
    mutate(invalid);
    assert.throws(() => removeReviewedPreparationEvalMatrixAdditions(invalid));
  }
});

test('model traces count completed shell calls once and retain prose for review', () => {
  const command = { id: 'c', type: 'command_execution', command: 'node command.mjs task snapshot', status: 'completed', exit_code: 0 };
  const receipt = parseTrace(lines(
    { type: 'thread.started', thread_id: 'session' },
    { type: 'item.started', item: { ...command, status: 'in_progress' } },
    { type: 'item.completed', item: command },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Please confirm this selection.' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'fixture', tool: 'inspect' } },
    { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 4 } },
  ));
  assert.equal(receipt.completed, true);
  assert.equal(receipt.sessionId, 'session');
  assert.equal(receipt.commands.length, 1);
  assert.equal(receipt.otherItems.length, 1);
  assert.deepEqual(receipt.messages, ['Please confirm this selection.']);
  assert.deepEqual(receipt.usage, { input_tokens: 20, output_tokens: 4 });
});

test('prose claims and incomplete or failed turns do not establish completion', () => {
  const message = { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } };
  assert.equal(parseTrace(lines(message)).completed, false);
  assert.equal(parseTrace(lines(message, { type: 'turn.completed' }, { type: 'error', message: 'failure' })).completed, false);
  assert.equal(parseTrace(lines({ type: 'turn.failed' })).completed, false);
  assert.throws(() => parseTrace('{invalid'), SyntaxError);
});

test('process execution preserves a failed exit and terminates a timed-out child', async () => {
  const failed = await execute(process.execPath, ['-e', 'process.stdout.write("partial"); process.exitCode = 2']);
  assert.equal(failed.code, 2);
  assert.equal(failed.stdout, 'partial');
  const timed = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 });
  assert.equal(timed.failure, 'timeout');
  assert.notEqual(timed.code, 0);
});

test('resumed trials retain writable fixture access and reject configuration drift', () => {
  const expected = { workspace: '/fixture', model: 'test-model', turn: 2 };
  const args = agentArguments({ ...expected, sessionId: 'session' });
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'session']);
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  const actual = { count: 2, cwd: '/fixture', model: 'test-model', effort: 'medium',
    sandbox: { type: 'workspace-write', network_access: false } };
  assert.doesNotThrow(() => validateContext(actual, expected));
  for (const change of [{ sandbox: { type: 'read-only' } }, { count: 1 }, { model: 'other' },
    { effort: 'low' }, { cwd: '/owner' }, { sandbox: { type: 'workspace-write', network_access: true } }]) {
    assert.throws(() => validateContext({ ...actual, ...change }, expected), /configuration changed/);
  }
});

test('capture preserves UTF-8 split across process output chunks', async () => {
  const result = await execute(process.execPath, ['-e', `
    for (const stream of [process.stdout, process.stderr]) stream.write(Buffer.from([0xc3]));
    setTimeout(() => {
      for (const stream of [process.stdout, process.stderr]) stream.write(Buffer.from([0xa9]));
    }, 100);
  `]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'é');
  assert.equal(result.stderr, 'é');
});

test('timeout kills resistant descendants before returning', { skip: process.platform === 'win32' }, async () => {
  const descendant = 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)';
  const result = await execute(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:['ignore','pipe','ignore']});
    child.stdout.once('data', () => { console.log(child.pid); child.stdout.destroy(); });
    setInterval(() => {}, 1000);
  `], { timeout: 1000 });
  const pid = Number(result.stdout.trim());
  try {
    assert.equal(result.failure, 'timeout');
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    // SIGKILL delivery may precede final process reaping by a short interval.
    let alive = true;
    for (let index = 0; index < 50 && alive; index++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
      catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
    }
    assert.equal(alive, false, 'owned descendant survived process-group escalation');
  } finally {
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
});
