import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { answerHttp } from '../runtime/workspace-core/answers-http.js';
import { runAnswerCommand } from '../runtime/cli/native-answers.js';
import { answerKey, normalizeAnswerQuestion } from '../runtime/contracts/workspace/answers.js';
import { parse, serialize, fromJSON, get, object, set, text } from '../runtime/contracts/workspace/values.js';
const fixed = '2026-09-09T12:00:00Z';
const plain = value => JSON.parse(serialize(value));
function fixture() {
  let document = fromJSON({ schemaVersion: 1, answers: {}, metadata: { updatedAt: fixed }, redirects: {} });
  let writes = 0;
  const repository = { async answerTransaction(operation) {
    return operation(parse(serialize(document)), async next => { document = parse(serialize(next)); writes++; }, new Map());
  } };
  return { repository, service: new AnswersService(repository, () => fixed), document: () => document, writes: () => writes };
}
test('answer identity matches independent Python Unicode/numeric scope oracle', () => {
  const inputs = [
    ['ＦＵＬＬ width?  Straße', '{}'], ['What\u0085now\u001c?', '{"salary":9007199254740993,"float":1.0}'],
    ['Greek ΣΟΣ', '{"😀":1,"é":"é"}'], ['a\ufeffb', '{}'], ['日本語 Ⅳ ²?', '{"null":null,"flag":true}'],
  ];
  const script = `import sys,json\nsys.path.insert(0,'scripts')\nfrom job_apply_store.normalization import answer_key,normalize_question\nprint(json.dumps([[normalize_question(q),answer_key(q,json.loads(scope))] for q,scope in json.loads(sys.argv[1])]))`;
  const expected = JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(inputs)], { encoding: 'utf8' }));
  assert.deepEqual(inputs.map(([question, scope]) => [normalizeAnswerQuestion(question), answerKey(question, object(parse(scope), 'scope'))]), expected);
});
test('put, observe, review, edit and query agree with independent Python Store', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-answer-oracle-'));
  try {
    const script = `import sys,json,importlib.util\nfrom pathlib import Path\nsys.path.insert(0,'scripts')\nspec=importlib.util.spec_from_file_location('answer_reference','scripts/job-apply-store.py')\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.utc_now=lambda:'${fixed}'\ns=m.Store(Path(sys.argv[1]));s.initialize()\na=s.put_answer({'key':'plain','question':'Favorite color?','state':'confirmed','value':'blue'})\nb=s.observe_answer({'question':'Preferred editor?','value':'vim'})\nc=s.review_answer(b['key'],'accepted',1)\nd=s.update_answer('plain',{'value':'green'},1)\nprint(json.dumps([a,b,c,d,s.query_answers(),s.get_answer('plain')]))`;
    const expected = JSON.parse(execFileSync('python3', ['-c', script, join(root, 'python')], { encoding: 'utf8' }));
    const { service } = fixture();
    return (async () => {
      const a = await service.put(fromJSON({ key: 'plain', question: 'Favorite color?', state: 'confirmed', value: 'blue' }));
      const b = await service.observe(fromJSON({ question: 'Preferred editor?', value: 'vim' }));
      const c = await service.update(plain(b).key, fromJSON({}), 1n, false, 'accepted');
      const d = await service.update('plain', fromJSON({ value: 'green' }), 1n);
      assert.deepEqual([a,b,c,d,await service.query(),await service.get('plain')].map(plain), expected);
    })();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('sensitive values require consent and stay out of every incidental projection', async () => {
  const { service, writes } = fixture();
  const answer = fromJSON({ key: 'secret', question: 'Private answer?', state: 'sensitive', value: 'private-test-value' });
  await assert.rejects(service.put(answer), /remember consent/);
  assert.equal(writes(), 0);
  const saved = await service.put(answer, true);
  assert.equal(plain(saved).value, undefined);
  assert.equal(plain(await service.get('secret')).value, undefined);
  assert.ok(!serialize(await service.query()).includes('private-test-value'));
  assert.equal(plain(await service.get('secret', true)).value, 'private-test-value');
  await service.update('secret', fromJSON({ question: 'Updated private answer?' }), 1n);
  await assert.rejects(service.update('secret', fromJSON({ value: 'new-private-test-value' }), 2n), /remember consent/);
  assert.equal(writes(), 2);
});
test('revision/collision/review rejection leaves canonical bytes unchanged and unknown data lossless', async () => {
  const f = fixture();
  await f.service.put(parse('{"key":"a","question":"How many?","state":"confirmed","value":9007199254740993,"scope":{"number":1.0}}'));
  const before = serialize(f.document());
  await assert.rejects(f.service.update('a', fromJSON({ value: 'stale' }), 9n), /revision conflict/);
  await assert.rejects(f.service.update('a', fromJSON({}), 1n, false, 'accepted'), /pending/);
  assert.equal(serialize(f.document()), before);
  await assert.rejects(f.service.put(parse('{"key":"b","question":"How many!","state":"confirmed","value":1,"scope":{"number":1}}')), /collides/);
  assert.equal(serialize(f.document()), before);
  assert.match(before, /9007199254740993/);
  assert.match(before, /1\.0/);
  const answers = object(get(f.document(), 'answers'), 'answers');
  set(object(get(answers, 'a'), 'answer'), 'opaque', parse('{"huge":9007199254740995}'));
  await f.service.update('a', fromJSON({ source: 'user' }), 1n);
  assert.match(serialize(f.document()), /9007199254740995/);
});
test('HTTP and CLI share validation, explicit reveal and revision boundaries', async () => {
  const { repository } = fixture();
  const input = fromJSON({ key: 'a/b λ', question: 'Transport?', state: 'sensitive', value: 'secret' });
  await runAnswerCommand('answer-put', repository, new Map([['--remember-sensitive', '']]), async () => input);
  const path = `/api/answers/by-key/${Buffer.from('a/b λ').toString('base64url')}`;
  assert.equal(JSON.parse((await answerHttp(repository, 'GET', path, '')).body).value, undefined);
  assert.equal(JSON.parse((await answerHttp(repository, 'POST', `${path}/reveal`, '{}')).body).value, 'secret');
  await assert.rejects(answerHttp(repository, 'POST', `${path}/reveal`, '{"extra":true}'), /unsupported/);
  await assert.rejects(answerHttp(repository, 'PATCH', path, '{"patch":{"source":"user"},"expectedRevision":false}'), /positive integer/);
  await assert.rejects(answerHttp(repository, 'POST', '/api/answers', '{"answer":{},"rememberSensitive":"yes"}'), /boolean/);
  assert.equal(await answerHttp(repository, 'POST', `${path}/merge`, '{}'), null);
  assert.equal(await answerHttp(repository, 'POST', '/api/answers/cleanup-approve', '{}'), null);
});
test('exact matching respects alias, scope, accepted review and pending retries', async () => {
  const { service } = fixture();
  await service.put(fromJSON({ key: 'canonical', question: 'Preferred location?', aliases: ['Work city'], state: 'confirmed', value: 'Remote', scope: { region: 1 } }));
  assert.equal(plain(await service.find('WORK CITY!', fromJSON({ region: 1 }))).key, 'canonical');
  assert.equal(await service.find('Work city', fromJSON({ region: 2 })), null);
  const observed = plain(await service.observe(fromJSON({ question: 'Favorite editor?', value: 'vim' })));
  assert.equal(await service.find('Favorite editor?'), null);
  await service.update(observed.key, fromJSON({}), 1n, false, 'accepted');
  await assert.rejects(service.update(observed.key, fromJSON({}), 1n, false, 'accepted'), /revision conflict/);
  await assert.rejects(service.update(observed.key, fromJSON({}), 2n, false, 'accepted'), /pending/);
  assert.equal(plain(await service.find('Favorite editor?')).value, 'vim');
});
test('scope identity separates booleans from numbers recursively but equates integer and float', async () => {
  const { service } = fixture();
  for (const [key, scope] of [['bool', '{"nested":[{"flag":true}]}'], ['num', '{"nested":[{"flag":1}]}']]) {
    await service.put(parse(`{"key":"${key}","question":"Same question?","state":"confirmed","value":"${key}","scope":${scope}}`));
  }
  assert.equal(plain(await service.find('Same question?', parse('{"nested":[{"flag":true}]}'))).key, 'bool');
  assert.equal(plain(await service.find('Same question?', parse('{"nested":[{"flag":1.0}]}'))).key, 'num');
  await assert.rejects(service.put(parse('{"key":"float","question":"Same question?","state":"confirmed","value":1,"scope":{"nested":[{"flag":1.0}]}}')), /collides/);
  const observed = plain(await service.observe(parse('{"question":"Same question?","scope":{"nested":[{"flag":true}]}}')));
  assert.equal(observed.key, 'bool');
  assert.equal(plain(await service.get('num')).revision, 1);
});
test('HTTP missing answer details fail explicitly for direct and encoded identities', async () => {
  const { repository } = fixture();
  for (const path of ['/api/answers/missing', `/api/answers/by-key/${Buffer.from('missing').toString('base64url')}`]) {
    await assert.rejects(answerHttp(repository, 'GET', path, ''), /answer does not exist/);
  }
});

test('encoded answer keys preserve a leading BOM and never select or update its unprefixed peer', async () => {
  const { service, repository } = fixture();
  for (const [key, question, value] of [['x', 'Unprefixed question?', 'unprefixed'], ['\ufeffx', 'Prefixed question?', 'prefixed']]) {
    await service.put(fromJSON({ key, question, state: 'confirmed', value }));
  }
  const path = '/api/answers/by-key/' + Buffer.from('\ufeffx').toString('base64url');
  const selected = JSON.parse((await answerHttp(repository, 'GET', path, '')).body);
  assert.equal(selected.key, '\ufeffx');
  assert.equal(selected.value, 'prefixed');
  const updated = JSON.parse((await answerHttp(repository, 'PATCH', path,
    JSON.stringify({ patch: { value: 'updated-prefixed' }, expectedRevision: 1 }))).body);
  assert.equal(updated.key, '\ufeffx');
  assert.equal(updated.revision, 2);
  assert.equal(plain(await service.get('x')).value, 'unprefixed');
  assert.equal(plain(await service.get('x')).revision, 1);
  assert.equal(plain(await service.get('\ufeffx')).value, 'updated-prefixed');
});
