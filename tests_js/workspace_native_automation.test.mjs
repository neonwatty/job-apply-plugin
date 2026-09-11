import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialAutomationDocuments, createAutomationRepository } from '../runtime/store/native-automation.js';
import { AutomationService } from '../runtime/workspace-core/automation.js';
import { automationHttp } from '../runtime/workspace-core/automation-http.js';
import { resolveAccountRealm } from '../runtime/contracts/workspace/account-realm.js';
import { AccountsService } from '../runtime/workspace-core/accounts.js';
import { fromJSON, parse, serialize } from '../runtime/contracts/workspace/values.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
const fixed = '2026-09-11T12:00:00Z';
const plain = value => JSON.parse(serialize(value));
const profile = {schemaVersion:1,profile:{email:'profile@example.invalid'},metadata:{revision:1,createdAt:fixed,updatedAt:fixed}};

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-automation-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const documents = {...initialAutomationDocuments(fixed), profile:fromJSON(profile)};
  const writes = [], reads = [];
  for (const [name, document] of Object.entries(documents)) await atomicWritePointJson(join(root, `${name}.json`), document, {pathProfile:'3.12',intMaxStrDigits:4300});
  const repository = createAutomationRepository(async operation => operation({
    read:async name => { reads.push(name); return parse(await readFile(join(root, `${name}.json`), 'utf8')); },
    write:async (name, document) => { writes.push(name); await atomicWritePointJson(join(root, `${name}.json`), document, {pathProfile:'3.12',intMaxStrDigits:4300}); },
  }));
  return {root,writes,reads,repository,settings:new AutomationService(repository,()=>fixed),accounts:new AccountsService(repository,()=>fixed)};
}

test('settings and account writes match independent Python Store sequence and persisted documents', async t => {
  const f = await fixture(t);
  const url = 'https://example.wd1.myworkdayjobs.com/en-US/careers/job/42';
  const realm = resolveAccountRealm(url).realmRef;
  const ops = [
    ['get_automation_settings', []],
    ['update_automation_settings', [{enabled:true,signupEmail:'  synthetic@example.invalid  '},1]],
    ['update_automation_settings', [{enabled:true},2]],
    ['update_automation_settings', [{enabled:false},1]],
    ['update_automation_settings', [{signupEmail:''},3]],
    ['update_automation_settings', [{unknown:true},3]],
    ['update_automation_settings', [{automaticAccountCreation:1},3]],
    ['copy_profile_email_to_automation_settings', [1,3]],
    ['copy_profile_email_to_automation_settings', [2,4]],
    ['create_employer_account', [url,'  override@example.invalid  ']],
    ['create_employer_account', [url]],
    ['list_employer_accounts', []],
    ['get_employer_account', [realm]],
    ['update_employer_account', [realm,{signupEmailOverride:null},1]],
    ['update_employer_account', [realm,{signupEmailOverride:'new@example.invalid'},1]],
    ['update_employer_account', [realm,{signupEmailOverride:'new@example.invalid'},2]],
    ['update_employer_account', [realm,{providerId:'secret'},3]],
    ['get_employer_account', ['missing']],
    ['create_employer_account', ['https://example.fa.us1.oraclecloud.com/hcmUI/CandidateExperience/en-US/sites/careers/job/123']],
    ['list_employer_accounts', []],
  ];
  const script = `import sys,json,importlib.util
from pathlib import Path
sys.path.insert(0,str(Path('scripts').resolve()))
spec=importlib.util.spec_from_file_location('automation_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.utc_now=lambda:'${fixed}'
s=m.Store(Path(sys.argv[1]));s._now=lambda:'${fixed}';s.initialize();s.profile_path.write_text(sys.argv[3])
out=[]
for name,args in json.loads(sys.argv[2]):
 try: out.append({'value':getattr(s,name)(*args,public=True)})
 except m.StoreError as e: out.append({'error':str(e)})
print(json.dumps({'results':out,'settings':json.loads(s.automation_settings_path.read_text()),'accounts':json.loads(s.employer_accounts_path.read_text())}))`;
  const expected = JSON.parse(execFileSync('python3',['-c',script,join(f.root,'python'),JSON.stringify(ops),JSON.stringify(profile)],{encoding:'utf8'}));
  const actual = [];
  for (const [name,args] of ops) {
    try {
      let value;
      if (name === 'get_automation_settings') value = await f.settings.get(true);
      else if (name === 'update_automation_settings') value = await f.settings.update(fromJSON(args[0]),BigInt(args[1]),true);
      else if (name === 'copy_profile_email_to_automation_settings') value = await f.settings.copyProfileEmail(BigInt(args[0]),BigInt(args[1]),true);
      else if (name === 'create_employer_account') value = await f.accounts.create(args[0],fromJSON(args[1] ?? null),true);
      else if (name === 'get_employer_account') value = await f.accounts.get(args[0],true);
      else if (name === 'update_employer_account') value = await f.accounts.update(args[0],fromJSON(args[1]),BigInt(args[2]),true);
      else value = await f.accounts.list(true);
      actual.push({value:plain(value)});
    } catch (error) { actual.push({error:error.message}); }
  }
  assert.deepEqual(actual,expected.results);
  assert.deepEqual(JSON.parse(await readFile(join(f.root,'automation-settings.json'),'utf8')),expected.settings);
  assert.deepEqual(JSON.parse(await readFile(join(f.root,'employer-accounts.json'),'utf8')),expected.accounts);
  assert.deepEqual(f.writes,['automation-settings','automation-settings','automation-settings','employer-accounts','employer-accounts','employer-accounts','employer-accounts']);
  assert.equal(f.reads.filter(name=>name==='profile').length,2);
  assert.doesNotMatch(JSON.stringify(actual), /profile@example|synthetic@example|override@example|workday:v1/);
});

test('copy email never returns identity even in internal mode, failures do not persist', async t => {
  const f = await fixture(t);
  assert.deepEqual(plain(await f.settings.copyProfileEmail(1n,1n,false)),{copied:true,revision:2});
  const before = await readFile(join(f.root,'automation-settings.json'),'utf8');
  await assert.rejects(f.settings.update(fromJSON({passwordStrategy:'invalid'}),2n),/password strategy is unsupported/);
  assert.equal(await readFile(join(f.root,'automation-settings.json'),'utf8'),before);
  assert.equal(f.writes.length,1);
});


test('lazy document reads preserve unrelated operations and error ordering', async t => {
  const f = await fixture(t);
  await rm(join(f.root,'profile.json'));
  await f.settings.get(true);
  await f.accounts.list(true);
  assert.ok(!f.reads.includes('profile'));
  await rm(join(f.root,'employer-accounts.json'));
  await f.settings.update(fromJSON({enabled:true}),1n,true);
  await assert.rejects(f.settings.copyProfileEmail(1n,2n), /ENOENT/);
  assert.deepEqual(f.writes,['automation-settings']);
});

test('HTTP accepts only Python routes and exact revision payloads; public mutations redact identity', async t => {
  const f = await fixture(t);
  const call = (method,path,payload) => automationHttp(f.repository,method,path,JSON.stringify(payload));
  const response = await call('PATCH','/api/automation/settings',{patch:{signupEmail:'secret@example.invalid'},expectedRevision:1});
  assert.equal(response.status,200);
  assert.doesNotMatch(response.body,/secret@example/);
  await assert.rejects(call('PATCH','/api/automation/settings',{patch:{enabled:true},expectedRevision:true}),/positive integer/);
  await assert.rejects(call('POST','/api/automation/realm-resolve',{url:'https://example.wd1.myworkdayjobs.com',extra:true}),/only a portal URL/);
  const created = await call('POST','/api/employer-accounts',{url:'https://example.wd1.myworkdayjobs.com',signupEmailOverride:'private@example.invalid'});
  assert.doesNotMatch(created.body,/private@example|workday:v1/);
  const realm = JSON.parse(created.body).realmRef;
  assert.equal((await call('GET',`/api/employer-accounts/${realm}`,{})).body,created.body);
  await assert.rejects(call('GET','/api/employer-accounts/missing',{}),/does not exist/);
  for (const path of ['/api/automation/settings','/api/employer-accounts','/api/automation']) assert.equal(await call('GET',path,{}),null);
  for (const path of ['/api/trusted-fill/approve','/api/account-operation/recover','/api/account-operation/execute-synthetic']) assert.equal(await call('POST',path,{}),null);
});
