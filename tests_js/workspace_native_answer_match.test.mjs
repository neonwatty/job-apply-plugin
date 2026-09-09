import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fromJSON,get,object,parse,serialize,set,text} from '../runtime/contracts/workspace/values.js';
import {rankCandidates} from '../runtime/contracts/workspace/answer-match-scoring.js';
import {evaluateReuse} from '../runtime/contracts/workspace/answer-match-reuse.js';
import {scopeFingerprint} from '../runtime/contracts/workspace/answer-match-features.js';
import {semanticLookup} from '../runtime/workspace-core/answer-match.js';
const plain=value=>JSON.parse(serialize(value));
const candidate=(key,question,extra={})=>({answerKey:key,question,aliases:[],scope:{region:'alpha'},fieldClass:'authorization',sensitivity:'high',state:'confirmed',recordStatus:'active',reviewStatus:'accepted',valueState:'seen',...extra});
const packet=(question,candidates,extra={})=>({question,candidates,scope:{region:'alpha'},fieldClass:'authorization',sensitivity:'high',...extra});
const nativeRank=input=>rankCandidates({question:fromJSON(input.question),scope:fromJSON(input.scope),fieldClass:fromJSON(input.fieldClass),sensitivity:fromJSON(input.sensitivity),candidates:fromJSON(input.candidates),...(Object.hasOwn(input,'limit')?{limit:fromJSON(input.limit)}:{})}).map(plain);
function python(operation,items){
 const run=spawnSync('python3',['-c',String.raw`
import sys,json,importlib.util
spec=importlib.util.spec_from_file_location('match_oracle','scripts/job_apply_answer_match.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
operation=sys.argv[1]
result=[]
for item in json.load(sys.stdin):
 try:
  kwargs={ {'fieldClass':'field_class','useAuthority':'use_authority','allowedSensitiveFieldClasses':'allowed_sensitive_field_classes'}.get(k,k):v for k,v in item.items() }
  value=m.rank_candidates(**kwargs) if operation=='rank' else m.evaluate_reuse(**kwargs)
  result.append({'value':value})
 except Exception as error: result.append({'error':str(error)})
print(json.dumps(result))
`,operation],{cwd:new URL('..',import.meta.url),input:JSON.stringify(items),encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 return JSON.parse(run.stdout);
}
const capture=callback=>{try{return {value:callback()};}catch(error){return {error:error.message};}};

test('deterministic matcher agrees with Python on ranking, negation, Unicode, aliases and ambiguity',()=>{
 const fixtures=[
  packet('Are you authorized to work in this country?',[candidate('one','Are you authorized to work in this country?')]),
  packet('Eligible for employment in this nation?',[candidate('one','Authorized to work in this country?')]),
  packet('Not authorized to work in this country?',[candidate('one','Authorized to work in this country?')]),
  packet('Begin availability',[candidate('one','Start available'),candidate('two','Begin availability')]),
  packet('Future visa assistance',[candidate('one','Future visa assistance'),candidate('two','Later immigration help'),candidate('three','Future visa assistance needed')]),
  packet('Target alias',[candidate('one','Other question',{aliases:['Target alias']})]),
  packet('Straße ＷＯＲＫ ①',[candidate('one','STRASSE work 1')]),
  packet('İş Ⅳ café e\u0301',[candidate('one','i\u0307ş IV café é')]),
  packet('constructor prototype',[candidate('one','constructor other')]),
  packet('Work permission',[candidate('one','Work permission',{scope:{region:'beta'}}),candidate('two','Work permission',{sensitivity:'none'}),candidate('three','Work permission',{fieldClass:'other'})]),
  packet('single',[candidate('one','single unrelated')]),
  packet('___',[candidate('one','!!!')]),
  packet('question',[candidate('one','question'),candidate('one','question')]),
  packet('question',[],{limit:true}),
  packet('question',[],{limit:0}),
  packet('question',[],{fieldClass:'bad\n'}),
  packet('question',[candidate('one','question',{aliases:[null]})]),
  packet('question',[candidate('one','question',{scope:null})]),
 ];
 assert.deepEqual(fixtures.map(input=>capture(()=>nativeRank(input))),python('rank',fixtures));
});

test('reuse policy matches Python across sensitivity, authority, state and ambiguity',()=>{
 const fixtures=[];
 for(const mode of ['strict','bounded_loose']) for(const authority of ['none','accepted_record','per_use','bounded_policy']) {
  for(const sensitivity of ['none','personal','high']) for(const state of ['confirmed','inferred','missing','sensitive']) {
   for(const allow of [[],['authorization']]) {
    const record=candidate('one','Question',{sensitivity,state});
    fixtures.push({match:{answerKey:'one',confidenceBand:'exact',reasonCodes:['match_exact_question']},candidate:record,scope:record.scope,fieldClass:'authorization',sensitivity,mode,useAuthority:authority,allowedSensitiveFieldClasses:allow});
   }
  }
 }
 const base=fixtures[0];
 fixtures.push({...base,match:{...base.match,reasonCodes:['ambiguous_tie']}});
 fixtures.push({...base,useAuthority:'per_use',candidate:{...base.candidate,recordStatus:'deleted'}});
 fixtures.push({...base,useAuthority:'per_use',candidate:{...base.candidate,reviewStatus:'pending'}});
 fixtures.push({...base,useAuthority:'per_use',candidate:{...base.candidate,valueState:'unseen'}});
 fixtures.push({...base,useAuthority:'missing'});
 fixtures.push({...base,allowedSensitiveFieldClasses:'authorization'});
 const native=fixtures.map(input=>capture(()=>plain(evaluateReuse(Object.fromEntries(Object.entries(input).map(([key,value])=>[key,fromJSON(value)]))))));
 assert.deepEqual(native,python('reuse',fixtures));
});

test('scope identity retains numeric tokens, booleans, Unicode and nonfinite Python spellings',()=>{
 const values=['{"n":1}','{"n":1.0}','{"n":true}','{"n":9007199254740993}','{"ß":-0.0,"é":Infinity}'];
 assert.equal(new Set(values.map(value=>scopeFingerprint(parse(value)))).size,values.length);
 const record=fromJSON(candidate('one','Question',{scope:{n:1}}));
 const ranked=rankCandidates({question:text('Question'),scope:parse('{"n":1.0}'),fieldClass:text('authorization'),sensitivity:text('high'),candidates:[record]});
 assert.equal(plain(ranked[0]).confidenceBand,'none');
 assert.ok(plain(ranked[0]).reasonCodes.includes('scope_mismatch'));
});

test('canonical semantic lookup is value-free, non-mutating and validates its input',()=>{
 const record={key:'question.one',question:'Authorized to work?',aliases:[],scope:{},fieldClass:'general',sensitivity:'none',state:'confirmed',value:'PRIVATE_SENTINEL',revision:1,source:'user',updatedAt:'2026-09-09T00:00:00Z'};
 const document=fromJSON({schemaVersion:1,answers:{'question.one':record},metadata:{}}),before=serialize(document);
 const input=fromJSON({question:record.question,scope:{},fieldClass:'general',sensitivity:'none',mode:'strict',useAuthority:'accepted_record'});
 const result=semanticLookup(document,input);
 assert.equal(plain(result).mutated,false);
 assert.equal(plain(result).candidates[0].reasonCodes[0],'reuse_eligible');
 assert.ok(!serialize(result).includes('PRIVATE_SENTINEL'));
 assert.equal(serialize(document),before);
 set(object(input,'input'),'useAuthority',text('bad'));
 assert.throws(()=>semanticLookup(document,input),/semantic lookup is invalid/);
 set(object(input,'input'),'unsupported',true);
 assert.throws(()=>semanticLookup(document,input),/unsupported fields/);
 assert.equal(get(object(document,'document'),'schemaVersion').value,1n);
});

test('Unicode 15 boundary prevents newer outlined letters from granting reuse',()=>{
  // Unicode 16 outlined capital WORK compatibility-normalizes to ASCII on newer Node.
  const outlinedWork=String.fromCodePoint(0x1ccec,0x1cce4,0x1cce7,0x1cce0);
  const newerLetter=String.fromCodePoint(0x1c89);
  const fixtures=[
    packet(`Authorized to ${outlinedWork}`,[candidate('one','Authorized to WORK')]),
    packet(`Authorized ${newerLetter} WORK`,[candidate('one','Authorized WORK')]),
    packet(`cafe\u0301 ${outlinedWork} A\u030a`,[candidate('one','café WORK Å')]),
    packet(`A\u030a${newerLetter}\u0301work`,[candidate('one','Å work')]),
    packet('가 work e\u0301',[candidate('one','가 WORK é')]),
  ];
  assert.deepEqual(fixtures.map(input=>capture(()=>nativeRank(input))),python('rank',fixtures));
  const first=fixtures[0],match=nativeRank(first)[0];
  const reuse=plain(evaluateReuse({match:fromJSON(match),candidate:fromJSON(first.candidates[0]),scope:fromJSON(first.scope),
    fieldClass:text(first.fieldClass),sensitivity:text(first.sensitivity),mode:text('strict'),useAuthority:text('per_use')}));
  assert.notEqual(match.confidenceBand,'exact');
  assert.equal(reuse.reasonCodes[0],'owner_confirmation_required');
});
