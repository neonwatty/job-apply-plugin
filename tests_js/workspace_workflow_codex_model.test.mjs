import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexProposalArguments, codexProposalEnvironment } from '../evals/workflows/codex-model-config.mjs';
import { boundedCodexProcess } from '../evals/workflows/codex-model-process.mjs';
import { inspectCodexRequest } from '../evals/workflows/codex-model-probe.mjs';
import { codexProposalResult, createCodexModelTransport } from '../evals/workflows/codex-model-transport.mjs';
import { runCodexModelTrials } from '../evals/workflows/codex-model-trials.mjs';
import { proposalSchema } from '../evals/workflows/model-contract.mjs';

const proposal = '{"message":"Needs Info.","action":null}';
const event = value => JSON.stringify(value) + '\n';
const completed = event({ type: 'item.completed', item: { type: 'agent_message', text: proposal } })
  + event({ type: 'turn.completed' });

test('fixed Codex capability arguments disable ambient config, discovery and capability features', () => {
  const args = codexProposalArguments('/fixture');
  for (const option of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config']) assert.ok(args.includes(option));
  for (const config of ['features.shell_tool=false', 'features.code_mode_host=false', 'features.plugins=false',
    'features.apps=false', 'features.computer_use=false', 'web_search="disabled"', 'project_doc_max_bytes=0',
    'features.skip_host_skill_discovery=true', 'model_provider="openai"']) assert.ok(args.includes(config));
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(args.includes('--oss'), false);
  assert.equal(args.includes('resume'), false);
  const environment = codexProposalEnvironment('/fixture', '/auth');
  assert.equal(environment.CODEX_HOME, '/auth'); assert.equal(environment.HOME, '/fixture');
  assert.equal(environment.OPENAI_API_KEY, undefined); assert.equal(environment.HTTP_PROXY, undefined);
});

test('wire probe accepts only empty provider tools and exact closed schema', () => {
  const wire = { model: 'gpt-6.1-sol', text: { format: { type: 'json_schema', schema: proposalSchema } } };
  assert.equal(inspectCodexRequest(wire).noTools, true);
  assert.equal(inspectCodexRequest(wire).schemaBound, true);
  assert.equal(inspectCodexRequest({ ...wire, tools: [{ type: 'function', name: 'exec_command' }] }).noTools, false);
  assert.equal(inspectCodexRequest({ ...wire, tools: null }).noTools, false);
  assert.equal(inspectCodexRequest({ ...wire, text: { format: { type: 'json_schema', schema: {} } } }).schemaBound, false);
});

test('Codex event parser rejects failed, malformed, tool-bearing and unfinished turns', () => {
  const ok = { code: 0, failure: null, stdout: completed };
  assert.equal(codexProposalResult(ok).completed, true);
  for (const result of [{ ...ok, code: 1 }, { ...ok, failure: 'codex_process_deadline' },
    { ...ok, stdout: completed + event({ type: 'turn.failed' }) },
    { ...ok, stdout: completed + event({ type: 'item.completed', item: { type: 'command_execution' } }) },
    { ...ok, stdout: '{broken private diagnostic' },
    { ...ok, stdout: 'null\n' },
    { ...ok, stdout: event({ type: 'item.completed', item: { type: 'agent_message', text: proposal } }) }]) {
    assert.equal(codexProposalResult(result).completed, false);
  }
  assert.equal(codexProposalResult({ ...ok, stdout: completed.replace('Needs Info.', 'secret') }).text.includes('secret'), true);
});

test('process traces preserve UTF-8 characters split between stream chunks', { skip: process.platform === 'win32' }, async () => {
  const script = 'const bytes=Buffer.from("A🙂éZ");process.stdout.write(bytes.subarray(0,3));'
    + 'setTimeout(()=>process.stdout.write(bytes.subarray(3)),40);';
  const result = await boundedCodexProcess(process.execPath, ['-e', script], {
    environment: { PATH: process.env.PATH }, timeoutMs: 2000 });
  assert.equal(result.stdout, 'A🙂éZ');
  assert.equal(result.cleanupConfirmed, true);
});

test('bounded process kills a stalled process and refuses excessive output', { skip: process.platform === 'win32' }, async () => {
  const timeout = await boundedCodexProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    environment: { PATH: process.env.PATH }, timeoutMs: 30 });
  assert.equal(timeout.failure, 'codex_process_deadline');
  const output = await boundedCodexProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], {
    environment: { PATH: process.env.PATH }, maxBytes: 100 });
  assert.equal(output.failure, 'codex_process_output_limit');
});

test('recorded Codex trial controller retains incomplete reports and cleans each fixture', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-recorded-trials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let called = 0, cleaned = 0;
  const transport = { kind: 'recorded_transport', next: async () => ({ text: proposal,
    rawTrace: '{"recorded":true}', completed: ++called > 1 }) };
  const result = await runCodexModelTrials({ transport, revision: 'a'.repeat(40), outputDirectory: join(root, 'run'), trials: 3,
    fixtureFactory: async () => ({ model: {}, prompt: 'Fictional fixture.', readCanonical: async () => ({ value: 1 }),
      gradeCanonical: () => ({ preserved: true }), cleanup: async () => { cleaned++; } }) });
  assert.equal(result.failure, null); assert.equal(result.trials.length, 3); assert.equal(cleaned, 3);
  assert.equal(result.trials[0].complete, false); assert.equal(result.trials[1].complete, false);
  assert.equal(result.trials[1].canonicalStatePassed, true);
  assert.equal(result.trials[1].scenarioPassed, false);
  for (const trial of result.trials) assert.equal(trial.modelToolCalls, null);
});

test('actual installed Codex advertises no tools and rejects injected exec call without inference', {
  skip: !process.env.JOB_APPLY_CODEX_PROBE_BINARY, timeout: 30000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-probe-auth-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transport = await createCodexModelTransport({ binary: process.env.JOB_APPLY_CODEX_PROBE_BINARY, authHome: root });
  try {
    const receipt = await transport.verifyIsolation();
    const evidence = JSON.parse(receipt.evidence);
    assert.equal(evidence.probe.passed, true);
    assert.equal(evidence.probe.forbiddenCallRejected, true);
    assert.ok(evidence.probe.requests.every(request => request.noTools && request.schemaBound && !request.authPresent));
  } finally { await transport.close(); }
});

test('process group cleanup kills a descendant that outlives the Codex-shaped parent', {
  skip: process.platform === 'win32', timeout: 5000,
}, async () => {
  const script = 'const {spawn}=require("node:child_process");'
    + 'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});'
    + 'console.log(child.pid);child.unref();';
  const result = await boundedCodexProcess(process.execPath, ['-e', script], {
    environment: { PATH: process.env.PATH }, timeoutMs: 2000 });
  assert.equal(result.cleanupConfirmed, true, JSON.stringify(result));
  const pid = Number(result.stdout.trim());
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
