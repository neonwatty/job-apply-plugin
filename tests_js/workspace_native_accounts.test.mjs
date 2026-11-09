import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolveAccountRealm } from '../runtime/contracts/workspace/account-realm.js';
import { validateAccount, publicAccount } from '../runtime/contracts/workspace/accounts.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
const plain = value => JSON.parse(serialize(value));

test('realm identity and rejection reasons match Python without URL canonicalization', () => {
  const oracle = 'https://example.fa.us1.oraclecloud.com/hcmUI/CandidateExperience/en-US/sites/careers/job/123';
  const base = 'https://example.wd1.myworkdayjobs.com';
  const urls = [null,0,'',' ',base,base+'/en/job/1',base+':443/a',base+':0443/a',base+':/a',base+':444/a',
    base+':999999/a',base+':abc/a',base+'.',base+'/a#',base+'/a#x',base+'/a?token=x',base+'/a?access_token=x',
    base+'/a?x_token_x=',base+'/a?%74oken=x',base+'/a?job=42',base+'/a?ſession=x',base+'/a?credentıal=x',base+'/a?COOKIE=x',base+'/a/../b',base+'/a\\b',
    'https://user@'+base.slice(8), 'https://@'+base.slice(8),base.replace('https:','http:'),
    '\u001c'+base+'\u0085','https://example.\nwd1.myworkdayjobs.com/x','https://wd1.myworkday.com',
    'https://unknown.invalid/path','https://[broken/path','https://[::1]/','//[broken','//example.invalid:bad','//example.invalid','https://example\uff1awd1.myworkdayjobs.com',
    oracle,oracle+'/apply/email',oracle+'/',oracle+'?x=y',oracle+'#x',oracle.replace('/sites/','//sites/'),
    oracle.replace('/job/','/%6aob/'),oracle.replace('/123','/01'),oracle.replace('en-US','en-us'),
    oracle.replace('.com/','.com./'),oracle.replace('careers','careers_two'),oracle.replace('careers','CAREERS'),
  ];
  const script = `import sys,json
sys.path.insert(0,'scripts')
import job_apply_accounts as a
print(json.dumps([a.normalize_realm(url) for url in json.loads(sys.argv[1])]))`;
  const expected = JSON.parse(execFileSync('python3',['-c',script,JSON.stringify(urls)],{encoding:'utf8'}));
  urls.forEach((url,index)=>assert.deepEqual(resolveAccountRealm(url),expected[index],JSON.stringify(url)));
});

test('account validation including legacy/provider combinations matches Python and redacts private fields', () => {
  const realm = resolveAccountRealm('https://example.wd1.myworkdayjobs.com');
  const base = {realmRef:realm.realmRef,adapterId:realm.adapterId,descriptorVersion:1,descriptor:realm.descriptor,
    flowKind:realm.flowKind,credentialRequired:true,signupEmailOverride:'synthetic@example.invalid',providerId:null,
    credentialRef:null,credentialVersion:null,lifecycleState:'discovered',revision:1,createdAt:'fixed',updatedAt:'fixed'};
  const records = [base,{...base,revision:true},{...base,revision:0},{...base,revision:1.5},{...base,descriptor:'bad'},
    {...base,unknown:'secret'},{...base,lifecycleState:'active'},
    {...base,providerId:'synthetic-provider',credentialRef:'credential_'+'0'.repeat(64),credentialVersion:1,lifecycleState:'active'},
    {...base,providerId:'x',credentialRef:'credential_'+'0'.repeat(64),credentialVersion:1,lifecycleState:'active'},
    {...base,signupEmailOverride:'bad'},{...base,signupEmailOverride:'\ufeffa@example.invalid'},
    {...base,signupEmailOverride:'a\u0085b@example.invalid'},
    Object.fromEntries(Object.entries(base).filter(([key])=>!['flowKind','credentialRequired'].includes(key)))];
  const script = `import sys,json
sys.path.insert(0,'scripts')
from job_apply_store.accounts_runtime import validate_employer_account
import job_apply_accounts as a
out=[]
for r in json.loads(sys.argv[1]):
 try: validate_employer_account(r['realmRef'],r);out.append({'value':a.public_account(r)})
 except Exception as e: out.append({'error':str(e)})
print(json.dumps(out))`;
  const expected = JSON.parse(execFileSync('python3',['-c',script,JSON.stringify(records)],{encoding:'utf8'}));
  const actual = records.map(record=>{try{return {value:plain(publicAccount(validateAccount(record.realmRef,fromJSON(record))))};}catch(error){return {error:error.message};}});
  assert.deepEqual(actual,expected);
  assert.doesNotMatch(JSON.stringify(actual),/synthetic@example|credential_0|workday:v1|synthetic-provider/);
});
