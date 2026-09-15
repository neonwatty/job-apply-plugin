import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { nativeFixture, child } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { now, rule, authorization, campaignInput, reference, capability, deterministicOptions } from './final_action_policy_support.mjs';
const serviceModule = await import('../runtime/final-action-policy/service.js').catch(() => null);
const serviceURL = new URL('../runtime/final-action-policy/service.js', import.meta.url).href;
const providerURL = new URL('../runtime/store/posix-flock.js', import.meta.url).href;
const prelude = `import { FinalActionPolicyService } from ${JSON.stringify(serviceURL)};
import { loadPosixFlockProvider } from ${JSON.stringify(providerURL)};
const service = new FinalActionPolicyService(process.argv[1], { provider: loadPosixFlockProvider(process.argv[2]), clock: () => new Date(${JSON.stringify(now)}) });`;
function runProcess(directory, addon, expression) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', `${prelude}
try { console.log(JSON.stringify({ ok: await (${expression}) })); } catch (error) { console.log(JSON.stringify({ error: error.message })); }`, directory, addon], { env: { PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    process.stdout.on('data', value => { output += value; });
    process.stderr.on('data', value => { errors += value; });
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
}
async function fixture(t) {
  assert.ok(serviceModule, 'native final-action service is not implemented');
  const native = await nativeFixture();
  t.after(native.cleanup);
  const directory = await mkdtemp(join(tmpdir(), 'policy-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new serviceModule.FinalActionPolicyService(directory, deterministicOptions(loadPosixFlockProvider(native.receipt.artifact)));
  return { directory, addon: native.receipt.artifact, service };
}
test('twelve processes reserve unique contiguous slots, enforce cap and reuse identical leases', async t => {
  const { directory, addon, service } = await fixture(t);
  const rules = Array.from({ length: 12 }, (_, index) => ({ ...rule, applicationRef: reference('application', index + 50) }));
  await service.activate({ ...campaignInput, applicationRules: rules });
  const results = await Promise.all(rules.map(item => runProcess(directory, addon, `service.authorize(${JSON.stringify({ ...authorization, ...item })})`)));
  const winners = results.filter(item => item.ok?.mode === 'auto_submit');
  assert.deepEqual(winners.map(item => item.ok.slot).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(results.filter(item => item.ok?.reason === 'application_limit').length, 2);
  const winner = winners[0].ok;
  const request = { ...authorization, ...rules.find(item => item.applicationRef === winner.applicationRef) };
  const repeats = await Promise.all(Array.from({ length: 12 }, () => runProcess(directory, addon, `service.authorize(${JSON.stringify(request)})`)));
  for (const item of repeats) assert.deepEqual(item.ok, winner);
});
test('twelve claimants permit one winner; callback failure consumes authority', async t => {
  const { directory, addon, service } = await fixture(t);
  await service.activate(campaignInput);
  const lease = await service.authorize(authorization);
  const args = [rule.applicationRef, lease.leaseId, lease.attempt, authorization, capability].map(JSON.stringify).join(',');
  const results = await Promise.all(Array.from({ length: 12 }, () => runProcess(directory, addon, `service.claim(${args}, () => { throw new Error('activation failed'); })`)));
  assert.equal(results.filter(item => item.error === 'activation failed').length, 1);
  assert.equal(results.filter(item => item.error === 'final action lease is already claimed or consumed').length, 11);
  assert.equal((await service.authorize(authorization)).reason, 'action_claimed');
});
test('kill waits for the callback under the same lock; killing first denies activation', async t => {
  const { directory, addon, service } = await fixture(t);
  await service.activate(campaignInput);
  const lease = await service.authorize(authorization);
  const args = [rule.applicationRef, lease.leaseId, lease.attempt, authorization, capability].map(JSON.stringify).join(',');
  const holder = child(`${prelude}
await service.claim(${args}, async () => {
  console.log('callback-entered');
  await new Promise(resolve => process.stdin.once('data', resolve));
  console.log('callback-left');
});`, [directory, addon]);
  t.after(() => holder.stop());
  await holder.line('callback-entered');
  const killer = child(`${prelude}\nconsole.log('kill-started');\nawait service.kill();\nconsole.log('kill-finished');`, [directory, addon]);
  t.after(() => killer.stop());
  await killer.line('kill-started');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(killer.lines.includes('kill-finished'), false);
  const stored = JSON.parse(await readFile(join(directory, 'auto-submit/campaign.json'), 'utf8'));
  assert.equal(stored.killSwitch, false);
  holder.process.stdin.end('release');
  await holder.success();
  await killer.line('kill-finished');
  await killer.success();
  const denied = await runProcess(directory, addon, `service.claim(${args})`);
  assert.equal(denied.error, 'final action is not authorized: kill_switch');
});

test('a killed unconsumed lease invokes no activation callback', async t => {
  const { service } = await fixture(t);
  await service.activate(campaignInput);
  const lease = await service.authorize(authorization);
  await service.kill();
  let activations = 0;
  await assert.rejects(service.claim(rule.applicationRef, lease.leaseId, lease.attempt, authorization, capability, () => { activations++; }), /kill_switch/);
  assert.equal(activations, 0);
});
