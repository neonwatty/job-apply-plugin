import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateCoordinator, publicClaim, makeClaim, requireClaim, requireJobUnclaimed, heartbeatClaim, claimExpired, claimTokenHash } from '../runtime/contracts/workspace/claims.js';
import { claimTime } from '../runtime/contracts/workspace/claim-time.js';
import { fromJSON, serialize, text, parse } from '../runtime/contracts/workspace/values.js';
import { claim, now, cases } from './workspace_claims_contracts_support.mjs';
const plain = value => JSON.parse(serialize(value));
function invoke(item) {
  switch (item.op) {
    case 'time': return claimTime(item.value).toString();
    case 'validate': return plain(validateCoordinator(fromJSON(item.coordinator)));
    case 'hash': return claimTokenHash(parse(JSON.stringify(item.token)));
    case 'public': return plain(publicClaim(fromJSON(item.coordinator.claim), item.now));
    case 'require': return plain(requireClaim(fromJSON(item.coordinator),fromJSON(item.jobs),item.jobId,parse(JSON.stringify(item.token)),item.now,item.allowExpired));
    case 'unclaimed': requireJobUnclaimed(fromJSON(item.coordinator),item.jobId); return null;
  }
}
test('claim contracts match original Python validation, tokens, expiry and error ordering', () => {
  const inputs = cases();
  const oracle = JSON.parse(execFileSync('python3',['tools/contracts/claims/reference.py'],{
    input:JSON.stringify(inputs),encoding:'utf8',maxBuffer:1024*1024,
  }));
  const result = inputs.map(item => {
    try { return {value:invoke(item)}; }
    catch (error) { return {error:error.name === 'UnicodeEncodeError' ? 'UnicodeEncodeError' : error.message}; }
  });
  for (let i=0;i<inputs.length;i++) assert.deepEqual(result[i],oracle[i],JSON.stringify(inputs[i]));
});
test('new claims return unique bearer tokens but only persist hashes and publish metadata', () => {
  const first = makeClaim('job-1',text('\u0085 Owner \u001c'),now);
  const second = makeClaim('job-1',text('Owner'),now);
  assert.match(first.token,/^claim_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token,second.token);
  const persisted = plain(first.claim);
  assert.equal(persisted.ownerLabel,'Owner');
  assert.equal(persisted.tokenHash,createHash('sha256').update(first.token).digest('hex'));
  assert.equal(persisted.expiresAt,'2026-09-10T12:05:00Z');
  assert.ok(!serialize(first.claim).includes(first.token));
  const published = plain(publicClaim(first.claim,now));
  assert.equal(published.tokenHash,undefined);
  assert.equal(published.expired,false);
  validateCoordinator(fromJSON({schemaVersion:1,claim:persisted}));
});
test('heartbeat preserves identity and input and renews at exact expiry boundary', () => {
  const original = fromJSON(claim), before = serialize(original);
  const heartbeat = plain(heartbeatClaim(original,'2026-09-10T12:04:59.999999Z'));
  assert.equal(heartbeat.heartbeatAt,'2026-09-10T12:04:59Z');
  assert.equal(heartbeat.expiresAt,'2026-09-10T12:09:59Z');
  assert.equal(heartbeat.tokenHash,claim.tokenHash);
  assert.equal(serialize(original),before);
  assert.equal(claimExpired(original,'2026-09-10T12:04:59.999999Z'),false);
  assert.equal(claimExpired(original,'2026-09-10T12:05:00Z'),true);
});
