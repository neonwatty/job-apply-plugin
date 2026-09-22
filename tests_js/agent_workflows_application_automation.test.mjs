import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url),read=path=>readFile(new URL(path,root),'utf8');

test('application automation workflow is synthetic, local-only, and review bounded',async()=>{
  const [workflow,fixture,portal]=await Promise.all([
    read('.workflows/workflows/job-apply.synthetic-application-automation.workflow.yaml'),
    read('.workflows/fixtures/job-apply.synthetic-application-automation-v1/fixture.json').then(JSON.parse),
    read('.workflows/fixtures/job-apply.synthetic-application-automation-v1/portal.mjs'),
  ]);
  assert.equal(fixture.syntheticOnly,true);assert.match(fixture.job.url,/\.example\.invalid\//);
  assert.deepEqual(fixture.requiredOperations,['fill_canonical_profile','upload_managed_resume','fill_confirmed_answer','navigate_non_final']);
  assert.match(workflow,/local-only/);assert.match(workflow,/Never invoke the synthetic Submit application action/);
  assert.match(workflow,/final_review/);assert.match(workflow,/no submitted or applied event/);
  assert.match(portal,/decision\.authorized!==true/);assert.match(portal,/campaign_to_review/);assert.match(portal,/finalActionActivated=true/);
});

test('agent mode selection separates setup preference from exact live authority',async()=>{
  const [setup,questions,automation,jobApply]=await Promise.all([
    read('skills/application-setup/SKILL.md'),read('skills/application-setup/references/setup-questions.md'),
    read('skills/job-apply/references/application-automation.md'),read('skills/job-apply/SKILL.md'),
  ]);
  assert.match(setup,/preferredAutomationMode[\s\S]*not a live grant/);
  assert.match(questions,/guided[\s\S]*autofill_to_review[\s\S]*campaign_to_review/);
  assert.match(questions,/every mode stops at final review/);
  assert.match(jobApply,/preferredAutomationMode[\s\S]*saved preference is never authority/);
  assert.match(automation,/Require explicit approval of that[\s\S]*summary in the current conversation/);
  assert.match(automation,/application-authority-set[\s\S]*--expected-revision/);
  assert.match(automation,/Choosing Guided requires no grant/);
});

test('local live-agent runner uses three clean ephemeral trials and is excluded from CI',async()=>{
  const [runner,schema,evaluator,prepare]=await Promise.all([
    read('tools/local-agent-acceptance.mjs'),
    read('.workflows/fixtures/job-apply.synthetic-application-automation-v1/result.schema.json'),
    read('.workflows/fixtures/job-apply.synthetic-application-automation-v1/evaluate.mjs'),
    read('.workflows/fixtures/job-apply.synthetic-application-automation-v1/prepare.mjs'),
  ]);
  assert.match(runner,/if\(process\.env\.CI\)throw Error/);assert.match(runner,/let trials=3/);
  assert.match(runner,/runAgent\(\['exec','--ephemeral'/);assert.match(runner,/--sandbox','danger-full-access'/);
  assert.match(runner,/--disable','skill_search'/);
  assert.match(runner,/approval_policy="never"/);
  assert.match(runner,/model='gpt-5\.6-luna'/);assert.match(runner,/child\.stdin\.end\(\)/);
  assert.match(runner,/sourceFingerprint/);assert.match(runner,/Never invoke the portal submit command/);
  assert.match(runner,/Current owner approval:[\s\S]*exact synthetic job for 120 minutes/);
  assert.match(runner,/preferredAutomationMode[\s\S]*Treat it only as a preference, not authority/);
  assert.match(runner,/application-authority-status[\s\S]*application-authority-set/);
  assert.doesNotMatch(prepare,/ApplicationAuthorityService/);assert.match(prepare,/preferredAutomationMode:'campaign_to_review'/);
  const contract=JSON.parse(schema);assert.equal(contract.properties.finalActionActivated.type,'boolean');
  assert.equal(contract.properties.authorityActivations.maximum,1);
  assert.deepEqual(contract.properties.outcome.enum,['passed','failed']);
  assert.match(evaluator,/preferredAutomationMode,'campaign_to_review'/);
  assert.match(evaluator,/portal\.stage,'final_review'/);assert.match(evaluator,/finalActionActivated,false/);
  assert.match(evaluator,/\['job-started','reviewed'\]/);
});
