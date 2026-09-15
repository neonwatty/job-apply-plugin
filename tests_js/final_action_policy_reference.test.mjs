import assert from 'node:assert/strict';
import test from 'node:test';
import { oracle, rule, sensitive, authorization, capability, campaignInput, confirmation, reference } from './final_action_policy_support.mjs';

const model = await import('../runtime/final-action-policy/model.js').catch(() => null);
const cases = [
  { op: 'rule', value: rule }, { op: 'sensitive', value: sensitive },
  { op: 'authorization', value: authorization }, { op: 'authority', value: capability },
  ...[null, [], {}, { ...rule, rawURL: 'private-marker' }, { ...rule, ats: 'Workday' },
    ...['file://host', 'https://user:password@host', 'https://host/', 'https://host/path', 'https://host?token=secret', 'https://host#secret', 'host'].map(origin => ({ ...rule, origin })),
    { ...rule, applicationRef: reference('answer', 2) }, { ...rule, formRevision: 'private-marker' }].map(value => ({ op: 'rule', value })),
  ...[null, [], { ...authorization, answerRevisions: [sensitive, sensitive] }, { ...authorization, answerRevisions: [{}] }, { ...authorization, answerRevisions: 'private-marker' }].map(value => ({ op: 'authorization', value })),
  ...['2026-08-14T16:00:00Z', '2026-08-14T12:00:00-04:00', null, '', '2026-02-30T00:00:00Z', '2026-08-14T16:00:00', 'garbage'].map(value => ({ op: 'time', value })),
  { op: 'digest', value: { unicode: 'é😀', nested: [false, 1, null] } },
  ...[null, 'secret', 'D'.repeat(64)].map(value => ({ op: 'authority', value })),
];
for (const change of [{}, { proof: '0'.repeat(64) }, { source: 'model' }, { activationObserved: false }, { raw: 'private-marker' }, { claimId: reference('claim', 100) }]) {
  cases.push({ op: 'confirmation', value: { ...confirmation(reference('claim', 3)), ...change }, claimId: reference('claim', 3), authority: campaignInput.confirmationAuthorityRevision, capability });
}
test('closed model and crypto match deterministic Python vectors', () => {
  assert.ok(model, 'native policy model is not implemented');
  const expected = oracle(cases).results;
  const parsers = { rule: model.parseRule, sensitive: model.parseSensitive, authorization: model.parseAuthorization, authority: model.confirmationAuthorityRevision, digest: model.digest, time: model.parseTime };
  const actual = cases.map(item => {
    try { return { ok: item.op === 'confirmation' ? model.parseConfirmation(item.value, item.claimId, item.authority, item.capability) : parsers[item.op](item.value) }; }
    catch (error) { return { error: error.message }; }
  });
  assert.deepEqual(actual, expected);
  assert.ok(actual.filter(item => item.error).every(item => !item.error.includes('private-marker')));
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { now, nativeCases } from './final_action_policy_support.mjs';
const campaignModule = await import('../runtime/final-action-policy/campaigns.js').catch(() => null);

test('campaign lifecycle, private bytes, expiry, sticky kill, and archives match Python', async t => {
  assert.ok(campaignModule, 'native campaigns are not implemented');
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const campaign = { schemaVersion: 1, campaignId: reference('campaign', 1), mode: 'auto_submit', status: 'active', createdAt: now, expiresAt: '2026-08-14T16:00:01Z', maxApplications: 10, applicationRules: [rule], resumeRevision: authorization.resumeRevision, sensitiveAllowlist: [sensitive], confirmationAuthorityRevision: campaignInput.confirmationAuthorityRevision, riskAcknowledgedAt: now, killSwitch: false, killSwitchAt: null, reservedApplications: 0 };
  const archive = `auto-submit/campaigns/${reference('campaign', 1).split(':')[1]}.json`;
  const scenarios = [
    [{ op: 'status' }, { op: 'activate', value: campaignInput }, { op: 'status' }, { op: 'activate', value: campaignInput }, { op: 'revoke' }, { op: 'status' }, { op: 'activate', value: campaignInput }, { op: 'kill' }, { op: 'revoke' }, { op: 'activate', value: campaignInput }, { op: 'status' }],
    ...[false, 'yes', null].map(riskAcknowledged => [{ op: 'activate', value: { ...campaignInput, riskAcknowledged } }]),
    ...[0, 11, true, 1.5].map(maxApplications => [{ op: 'activate', value: { ...campaignInput, maxApplications } }]),
    ...[0, 14401, true, 0.5].map(durationSeconds => [{ op: 'activate', value: { ...campaignInput, durationSeconds } }]),
    ...[{ raw: 'private-marker' }, { applicationRules: [rule, rule] }, { sensitiveAllowlist: [sensitive, sensitive] }, { applicationRules: [] }].map(change => [{ op: 'activate', value: { ...campaignInput, ...change } }]),
    [{ op: 'activate', value: { ...campaignInput, durationSeconds: 1 } }, { op: 'status', now: '2026-08-14T16:00:02Z' }, { op: 'activate', value: campaignInput, now: '2026-08-14T16:00:02Z' }],
    ...[campaign, { ...campaign, reservedApplications: 1 }].map(archived => [{ op: 'activate', value: { ...campaignInput, durationSeconds: 1 } }, { op: 'write', path: archive, value: JSON.stringify(archived) }, { op: 'activate', value: campaignInput, now: '2026-08-14T16:00:02Z' }]),
    ...['not json', JSON.stringify({ ...campaign, schemaVersion: 99 }), JSON.stringify({ ...campaign, raw: 'private-marker' })].map(value => [{ op: 'write', path: 'auto-submit/campaign.json', value }, { op: 'status' }]),
  ];
  for (const scenario of scenarios) {
    const directory = await mkdtemp(join(tmpdir(), 'policy-campaign-'));
    try {
      const timed = scenario.map(item => ({ now, ...item }));
      const expected = oracle(timed);
      const actual = await nativeCases(campaignModule.CampaignPolicy, directory, provider, timed);
      assert.deepEqual(actual.results, expected.results, JSON.stringify(scenario));
      assert.deepEqual(actual.tree.entries, expected.tree.entries);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

const serviceModule = await import('../runtime/final-action-policy/service.js').catch(() => null);
const claimValue = { application_ref: rule.applicationRef, lease_id: reference('lease', 2), attempt_ordinal: 1, observed_authorization: authorization, action_capability: capability };
const outcomeValue = { campaign_id: reference('campaign', 1), application_ref: rule.applicationRef, lease_id: reference('lease', 2), claim_id: reference('claim', 3), outcome: 'uncertain' };
const initial = [{ op: 'activate', value: campaignInput }, { op: 'authorize', value: authorization }];
const claimed = [...initial, { op: 'claim', value: claimValue }];
test('authorization, claims, outcomes, retries and projection repair preserve Python results and bytes', async t => {
  assert.ok(serviceModule, 'native final-action service is not implemented');
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const scenarios = [
    [{ op: 'authorize', value: authorization }],
    [...initial, { op: 'authorize', value: authorization }, { op: 'claim', value: claimValue }, { op: 'claim', value: claimValue }, { op: 'authorize', value: authorization }],
    ...['origin', 'urlFingerprint', 'ats', 'jobFingerprint', 'resumeRevision', 'formRevision', 'finalControlRevision'].map(field => [...initial, { op: 'authorize', value: { ...authorization, [field]: field === 'origin' ? 'https://other.test' : field === 'ats' ? 'workday' : sensitive.answerRevision } }]),
    ...[{ answerRevisions: [{ ...sensitive, answerRevision: authorization.resumeRevision }] }, { raw: 'private-marker' }, { answerRevisions: [] }].map(change => [...initial, { op: 'authorize', value: { ...authorization, ...change } }]),
    [...initial, { op: 'authorize', value: authorization, now: '2026-08-14T16:05:00Z' }],
    ...[{ action_capability: 'e'.repeat(64) }, { lease_id: reference('lease', 99) }, { attempt_ordinal: 2 }, { observed_authorization: { ...authorization, origin: 'https://other.test' } }].map(change => [...initial, { op: 'claim', value: { ...claimValue, ...change } }]),
    [...initial, { op: 'kill' }, { op: 'claim', value: claimValue }],
    [...initial, { op: 'revoke' }, { op: 'claim', value: claimValue }],
    ...['uncertain', 'blocked', 'confirmed_submitted'].map(outcome => [...claimed, { op: 'outcome', value: { ...outcomeValue, outcome } }, { op: 'authorize', value: authorization }]),
    [...claimed, { op: 'outcome', value: outcomeValue }, { op: 'remove', path: 'auto-submit/receipts.jsonl' }, { op: 'outcome', value: outcomeValue }, { op: 'outcome', value: outcomeValue }, { op: 'authorize', value: authorization }, { op: 'claim', value: { ...claimValue, lease_id: reference('lease', 5), attempt_ordinal: 2 } }, { op: 'outcome', value: { ...outcomeValue, lease_id: reference('lease', 5), claim_id: reference('claim', 6) } }, { op: 'authorize', value: authorization }],
    ...[{}, { proof: '0'.repeat(64) }, { source: 'untrusted' }, { activationObserved: false }, { observedAt: '2026-08-14T16:01:00Z' }].map(change => [...claimed, { op: 'outcome', value: { ...outcomeValue, outcome: 'confirmed_submitted', confirmation_event: { ...confirmation(reference('claim', 3)), ...change }, confirmation_capability: capability } }]),
    [...claimed, { op: 'revoke' }, { op: 'activate', value: campaignInput }, { op: 'outcome', value: outcomeValue }],
  ];
  for (const scenario of scenarios) {
    const directory = await mkdtemp(join(tmpdir(), 'policy-outcome-'));
    try {
      const timed = scenario.map(item => ({ now, ...item }));
      const expected = oracle(timed);
      const actual = await nativeCases(serviceModule.FinalActionPolicyService, directory, provider, timed);
      assert.deepEqual(actual.results, expected.results, JSON.stringify(scenario));
      assert.deepEqual(actual.tree.entries, expected.tree.entries);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('every persisted document field is closed and malformed relationships fail closed', async () => {
  const repository = await import('../runtime/final-action-policy/repository.js');
  const scenario = [...claimed, { op: 'outcome', value: outcomeValue }].map(item => ({ now, ...item }));
  const stored = oracle(scenario);
  const campaign = stored.results[0].ok;
  const receipt = stored.results.at(-1).ok;
  const applicationEntry = Object.entries(stored.tree.entries).find(([path]) => path.includes('/applications/') && path.endsWith('.json'));
  const application = JSON.parse(applicationEntry[1].bytes);
  const groups = [['campaign', campaign, campaignModule.parseCampaign], ['application', application, repository.parseApplication], ['receipt', receipt, model.parseReceipt]];
  for (const [op, valid, parse] of groups) {
    const values = [valid, { ...valid, schemaVersion: 0 }, { ...valid, schemaVersion: 2 }, { ...valid, raw: 'private-marker' }];
    for (const field of Object.keys(valid)) {
      const missing = { ...valid };
      delete missing[field];
      values.push(missing, { ...valid, [field]: null }, { ...valid, [field]: [] });
    }
    const expected = oracle(values.map(value => ({ op, value }))).results;
    values.forEach((value, index) => {
      let accepted;
      try { parse(value); accepted = true; } catch { accepted = false; }
      assert.equal(accepted, Object.hasOwn(expected[index], 'ok'), `${op}: ${JSON.stringify(value)}`);
    });
    assert.throws(() => parse({ ...valid, schemaVersion: true }));
  }
  const variants = [
    { ...application, authorizationFingerprint: campaign.resumeRevision },
    { ...application, status: 'lease_issued' },
    { ...application, attempts: [] },
    ...['leaseId', 'claimId', 'outcome', 'confirmationRevision', 'receipt', 'outcomeAt', 'claimedAt'].map(field => ({ ...application, attempts: [{ ...application.attempts[0], [field]: null }] })),
    { ...application, attempts: [{ ...application.attempts[0], receipt: { ...receipt, slot: receipt.slot + 1 } }] },
    { ...application, attempts: [{ ...application.attempts[0], expiresAt: '2026-08-14T17:00:00Z' }] },
  ];
  const expected = oracle(variants.map(value => ({ op: 'application', value }))).results;
  variants.forEach((value, index) => {
    let accepted;
    try { repository.parseApplication(value); accepted = true; } catch { accepted = false; }
    assert.equal(accepted, Object.hasOwn(expected[index], 'ok'));
  });
});

test('Python 3.12 timezone-aware timestamp spellings preserve microseconds and reject malformed times', () => {
  const values = ['2026-08-14T16Z', '2026-08-14X16:00:00+00:00', '2026-08-14T16:00:00.123456Z',
    '2026-08-14T16:00:00.1Z', '20260814T160000Z', '2026-08-14T16:00:00+00', '2026-08-14T16:00:00+0000',
    '2026-08-14T16:00:00+00:00:30', '2026-08-14T16:00:00+01:99', '2026-08-14T16:00:00-00:00:30.123456', '2026-W33-5T16:00:00Z', '2026W335T160000Z',
    '2026-W33T16:00:00Z', '2026-08-14T16.1Z', '2026-08-14T1600,1234567Z', '2026-08-14T16:00:00+00:00:00.1'];
  const expected = oracle(values.map(value => ({ op: 'time', value }))).results;
  const actual = values.map(value => { try { return { ok: model.parseTime(value) }; } catch (error) { return { error: error.message }; } });
  assert.deepEqual(actual, expected);
});

test('exact origins retain Python spellings and reject malformed host authorities', () => {
  const origins = ['HTTPS://Jobs.Example.test:443', 'https://é.example.test', 'http://[::1]:8080',
    'https://host?', 'https://host?#', ' https://host', 'https://ho\nst', 'http://[::1]suffix',
    'http://[not-ip]', 'http://[127.0.0.1]', 'https://host／path', 'https://:80', 'https://user@host'];
  const expected = oracle(origins.map(origin => ({ op: 'rule', value: { ...rule, origin } }))).results;
  origins.forEach((origin, index) => {
    let result;
    try { result = { ok: model.parseRule({ ...rule, origin }) }; } catch { result = { rejected: true }; }
    if (Object.hasOwn(expected[index], 'ok')) assert.deepEqual(result, expected[index]);
    else assert.deepEqual(result, { rejected: true }, origin);
  });
});

test('strict policy JSON rejects decimal authority tokens and malformed UTF-8 without rewriting', async () => {
  const { parsePolicyJson, decodePolicyBytes } = await import('../runtime/final-action-policy/model.js');
  for (const token of ['1.0', '1e0', '1E+0']) {
    assert.throws(() => parsePolicyJson(`{"schemaVersion":${token}}`));
    assert.throws(() => parsePolicyJson(`{"attempt":${token}}`));
  }
  assert.deepEqual(parsePolicyJson('{"schemaVersion":1,"attempt":2}'), { schemaVersion: 1, attempt: 2 });
  assert.equal(typeof decodePolicyBytes, 'function', 'strict UTF-8 policy decoder is missing');
  assert.throws(() => decodePolicyBytes(Buffer.from([0x22, 0xff, 0x22])));
  assert.throws(() => parsePolicyJson(decodePolicyBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))));
});

test('CPython 3.13 and 3.14 provide supplementary profile observations', t => {
  const profileCases = [...cases, ...['https://[::1]', ' https://host', 'http://[not-ip]'].map(origin => ({ op: 'rule', value: { ...rule, origin } }))];
  const normative = oracle(profileCases).results;
  for (const interpreter of ['python3.13', 'python3.14']) {
    const observed = oracle(profileCases, interpreter).results;
    const differences = observed.flatMap((value, index) => JSON.stringify(value) === JSON.stringify(normative[index]) ? [] : [index]);
    t.diagnostic(`${interpreter}: ${profileCases.length} observations; differing case indices: ${JSON.stringify(differences)}`);
    assert.equal(observed.length, normative.length);
  }
});

test('opaque tokens reject trailing line terminators and enum arrays never coerce into authority', async () => {
  const { parseCampaign } = await import('../runtime/final-action-policy/campaigns.js');
  const campaign = oracle([{ now, op: 'activate', value: campaignInput }]).results[0].ok;
  for (const suffix of ['\n', '\r', '\u2028', '\u2029']) {
    for (const field of ['applicationRef', 'ats', 'urlFingerprint', 'formRevision']) {
      assert.throws(() => model.parseRule({ ...rule, [field]: rule[field] + suffix }), field);
    }
    assert.throws(() => model.confirmationAuthorityRevision(capability + suffix));
    assert.throws(() => model.parseTime(now + suffix));
  }
  assert.throws(() => parseCampaign({ ...campaign, status: ['active'] }));
  const repository = await import('../runtime/final-action-policy/repository.js');
  const stored = oracle(initial.map(item => ({ now, ...item })));
  const entry = Object.entries(stored.tree.entries).find(([path]) => path.includes('/applications/') && path.endsWith('.json'));
  const application = JSON.parse(entry[1].bytes);
  assert.throws(() => repository.parseApplication({ ...application, status: ['lease_issued'] }));
});

test('ASCII receipt projection preserves accepted surrogate timestamp separators', () => {
  const stored = oracle([...claimed, { op: 'outcome', value: outcomeValue }].map(item => ({ now, ...item })));
  const receipt = { ...stored.results.at(-1).ok, at: '2026-08-14\ud80016:00:00Z' };
  const checked = oracle([{ op: 'receipt', value: receipt }]).results[0];
  assert.deepEqual(checked, { ok: receipt });
  const line = model.serializeReceiptLine(model.parseReceipt(receipt)).toString('utf8');
  assert.match(line, /\\ud800/);
  assert.deepEqual(JSON.parse(line), receipt);
  assert.equal(line.split('\n').length, 2);
});

test('CPython empty-fraction clocks remain usable in persisted campaigns', async t => {
  const timestamps = ['2026-08-14T16.Z', '2026-08-14T16,Z', '2026-08-14T16:00.Z',
    '2026-08-14T1600,Z', '2026-08-14T16:00:00.Z', '2026-08-14T160000,Z',
    '2026-08-14T16..Z', '2026-08-14T16:00:00+01.', '2026-08-14T16:00:00+01:00.',
    '2026-08-14T16:00:00+01:00:00.'];
  const expectedTimes = oracle(timestamps.map(value => ({ op: 'time', value }))).results;
  const actualTimes = timestamps.map(value => {
    try { return { ok: model.parseTime(value) }; } catch (error) { return { error: error.message }; }
  });
  assert.deepEqual(actualTimes, expectedTimes);
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const directory = await mkdtemp(join(tmpdir(), 'policy-empty-fraction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const campaign = oracle([{ now, op: 'activate', value: campaignInput }]).results[0].ok;
  const scenario = [
    { now, op: 'activate', value: campaignInput },
    { now, op: 'write', path: 'auto-submit/campaign.json', value: JSON.stringify({ ...campaign, createdAt: '2026-08-14T16.Z' }) },
    { now, op: 'status' }, { now, op: 'authorize', value: authorization },
  ];
  const expected = oracle(scenario);
  const actual = await nativeCases(serviceModule.FinalActionPolicyService, directory, provider, scenario);
  assert.deepEqual(actual.results, expected.results);
  assert.equal(actual.results[2].ok.mode, 'auto_submit');
  assert.equal(actual.results[3].ok.mode, 'auto_submit');
  assert.deepEqual(actual.tree.entries, expected.tree.entries);
});

test('IPvFuture introducer is lowercase while hexadecimal version letters keep both cases', () => {
  for (const origin of ['https://[VF.abc]', 'https://[Vf.abc]', 'https://[vF.abc]', 'https://[vf.abc]']) {
    const value = { ...rule, origin };
    const expected = oracle([{ op: 'rule', value }]).results[0];
    if (Object.hasOwn(expected, 'error')) assert.throws(() => model.parseRule(value), origin);
    else assert.deepEqual(model.parseRule(value), expected.ok);
  }
});
