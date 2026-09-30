import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function nativeAutomationBrowser(page, root) {
  await page.getByRole('button',{name:'Automation',exact:true}).click();
  const workspace=page.locator('.automation-workspace');
  await workspace.getByRole('heading',{name:'Automation',exact:true}).waitFor();
  await workspace.getByText('Guided mode',{exact:true}).waitFor();
  await workspace.getByRole('heading',{name:'Application automation',exact:true}).waitFor();
  await workspace.getByText('Guided · granular confirmation remains active',{exact:true}).waitFor();
  await workspace.getByText(/Every mode stops at final review/).waitFor();
  assert.equal(await workspace.getByLabel(/Enable companion automation controls/).isVisible(),false);
  assert.equal(await workspace.getByLabel('Exact employer portal URL',{exact:true}).isVisible(),false);
  await workspace.getByText('No queued jobs are available. Start an application run and prepare its jobs first.').waitFor();
  const refreshedJob={id:'refreshed-job',url:'https://example.invalid/refreshed',status:'ready',revision:1,
    role:'Refreshed role',company:'Synthetic employer'};
  await page.route('**/api/state',async route=>{
    const response=await route.fetch(),body=await response.json();
    await route.fulfill({response,json:{...body,jobs:[...body.jobs,refreshedJob],applicationRun:{
      runId:'refreshed-run',revision:1,selection:{resumeId:'synthetic-resume',factRevision:1},
      queueVersions:[{revision:1,jobIds:[refreshedJob.id]}],
    }}});
  });
  await workspace.getByRole('button',{name:'Refresh',exact:true}).click();
  await workspace.getByText('Refreshed role · Synthetic employer',{exact:true}).waitFor();
  const refreshedChoice=workspace.getByRole('checkbox',{name:/Refreshed role/});
  await refreshedChoice.check();
  await page.waitForFunction(()=>[...document.querySelectorAll('.automation-workspace button')]
    .some(button=>button.textContent?.trim()==='Refresh'&&button.disabled));
  await refreshedChoice.uncheck();
  await page.waitForFunction(()=>[...document.querySelectorAll('.automation-workspace button')]
    .some(button=>button.textContent?.trim()==='Refresh'&&!button.disabled));
  await page.unroute('**/api/state');
  await workspace.getByText('Trusted Fill approvals',{exact:true}).click();
  await workspace.getByLabel('Job ID for status or revocation',{exact:true}).fill('missing-job');
  await workspace.getByRole('button',{name:'Check approval status',exact:true}).click();
  await workspace.getByText('No approval exists for this job.',{exact:true}).waitFor();

  await page.getByRole('button',{name:'Accounts & Sign-in',exact:true}).click();
  const accountsWorkspace=page.locator('.accounts-workspace');
  await accountsWorkspace.getByRole('heading',{name:'Accounts & Sign-in',exact:true}).waitFor();
  await accountsWorkspace.getByText('Browser sessions not observed',{exact:true}).waitFor();
  await accountsWorkspace.getByText('Sign-in is yours to complete',{exact:true}).waitFor();
  assert.equal(await accountsWorkspace.getByLabel('Workday credential strategy').count(),0);
  assert.equal(await accountsWorkspace.getByLabel(/Allow protected Workday preparation/).count(),0);
  assert.equal(await accountsWorkspace.getByRole('button',{name:'Save settings',exact:true}).count(),0);
  const settingsBefore=await readFile(join(root,'automation-settings.json'),'utf8');

  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  await accountsWorkspace.getByLabel('Exact employer portal URL',{exact:true}).fill('https://job-boards.greenhouse.io/synthetic/jobs/123');
  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  await accountsWorkspace.getByRole('alert').getByText('This portal is not supported. Use an exact Workday or Oracle Recruiting job URL; direct Greenhouse applications need no account.',{exact:true}).waitFor();
  assert.equal(Object.keys(JSON.parse(await readFile(join(root,'employer-accounts.json'),'utf8')).accounts).length,0);
  await accountsWorkspace.getByLabel('Exact employer portal URL',{exact:true}).fill('https://acme.wd5.myworkdayjobs.com/en-US/jobs/one');
  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  await accountsWorkspace.getByText('Workday realm',{exact:true}).waitFor();
  await accountsWorkspace.getByText('Keychain setup pending',{exact:true}).waitFor();
  assert.equal(await readFile(join(root,'automation-settings.json'),'utf8'),settingsBefore);
  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  const unrelatedDraft='https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/331081';
  await accountsWorkspace.getByLabel('Exact employer portal URL',{exact:true}).fill(unrelatedDraft);
  await accountsWorkspace.getByRole('button',{name:'Add MyGreenhouse',exact:true}).click();
  await accountsWorkspace.getByText('Global account',{exact:true}).waitFor();
  assert.equal(await accountsWorkspace.getByRole('button',{name:'Refresh',exact:true}).isDisabled(),true);
  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  assert.equal(await accountsWorkspace.getByLabel('Exact employer portal URL',{exact:true}).inputValue(),unrelatedDraft);
  await accountsWorkspace.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await accountsWorkspace.getByLabel('Exact employer portal URL',{exact:true}).count(),0);
  assert.equal(await accountsWorkspace.getByRole('button',{name:'Refresh',exact:true}).isEnabled(),true);
  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  assert.equal(await accountsWorkspace.getByLabel('Exact employer portal URL',{exact:true}).inputValue(),'');
  await accountsWorkspace.getByRole('button',{name:'Cancel',exact:true}).click();
  const navigationPrompts=[];
  const acceptNavigation=async dialog=>{navigationPrompts.push(dialog.message());await dialog.accept();};
  page.on('dialog',acceptNavigation);
  try {
    await page.getByRole('button',{name:'Jobs',exact:true}).click();
    await page.getByRole('heading',{name:'Jobs',exact:true}).waitFor();
  } finally { page.off('dialog',acceptNavigation); }
  assert.deepEqual(navigationPrompts,[],'Cancel clears the hidden portal draft before navigation');
  await page.getByRole('button',{name:'Accounts & Sign-in',exact:true}).click();
  await accountsWorkspace.getByRole('heading',{name:'Accounts & Sign-in',exact:true}).waitFor();
  await accountsWorkspace.getByText('Global account',{exact:true}).waitFor();
  assert.equal(await accountsWorkspace.getByRole('listitem').count(),2);
  const persisted=JSON.parse(await readFile(join(root,'employer-accounts.json'),'utf8')).accounts;
  assert.equal(Object.values(persisted).every(account=>account.signupEmailOverride===null),true);
  assert.equal(Object.values(persisted).find(account=>account.adapterId==='mygreenhouse').providerId,null);
  await accountsWorkspace.getByText('Account not required',{exact:true}).waitFor();
  await accountsWorkspace.getByText('Not needed',{exact:true}).waitFor();
  await accountsWorkspace.getByRole('listitem').filter({hasText:'MyGreenhouse'}).getByRole('button',{name:'Remove saved account'}).click();
  await accountsWorkspace.getByRole('listitem').filter({hasText:'MyGreenhouse'}).waitFor({state:'detached'});
  assert.equal(Object.keys(JSON.parse(await readFile(join(root,'employer-accounts.json'),'utf8')).accounts).length,1);
  for (const width of [390,1280]) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  }
  return {settingsReadOnly:true,redactedRealm:true,removal:true,idleRecovery:true,trustedFillStatus:true,layouts:[390,1280],liveExecutionDisabled:true};
}
