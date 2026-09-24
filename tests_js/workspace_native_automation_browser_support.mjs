import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function nativeAutomationBrowser(page, root) {
  await page.getByRole('button',{name:'Automation',exact:true}).click();
  const workspace=page.locator('.automation-workspace');
  await workspace.getByRole('heading',{name:'Automation',exact:true}).waitFor();
  await workspace.getByText('Live actions off',{exact:true}).waitFor();
  await workspace.getByRole('heading',{name:'Application automation',exact:true}).waitFor();
  await workspace.getByText('Guided · granular confirmation remains active',{exact:true}).waitFor();
  await workspace.getByText(/Every mode stops at final review/).waitFor();
  assert.equal(await workspace.getByLabel(/Enable companion automation controls/).isVisible(),false);
  assert.equal(await workspace.getByLabel('Exact employer portal URL',{exact:true}).isVisible(),false);
  await workspace.getByText('Trusted Fill approvals',{exact:true}).click();
  await workspace.getByLabel('Job ID for status or revocation',{exact:true}).fill('missing-job');
  await workspace.getByRole('button',{name:'Check approval status',exact:true}).click();
  await workspace.getByText('No approval exists for this job.',{exact:true}).waitFor();

  await page.getByRole('button',{name:'Accounts & Sign-in',exact:true}).click();
  const accountsWorkspace=page.locator('.accounts-workspace');
  await accountsWorkspace.getByRole('heading',{name:'Accounts & Sign-in',exact:true}).waitFor();
  await accountsWorkspace.getByText('Browser sessions not observed',{exact:true}).waitFor();
  await accountsWorkspace.getByLabel(/Enable account preparation controls/).check();
  await accountsWorkspace.getByRole('button',{name:'Save settings',exact:true}).click();
  await accountsWorkspace.getByText('Account settings saved.',{exact:true}).waitFor();
  const settings=JSON.parse(await readFile(join(root,'automation-settings.json'),'utf8')).settings;
  assert.equal(settings.enabled,true);
  assert.equal(settings.revision,2);

  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  await accountsWorkspace.getByLabel('Exact employer portal URL',{exact:true}).fill('https://job-boards.greenhouse.io/synthetic/jobs/123');
  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  await accountsWorkspace.getByRole('alert').getByText('This portal is not supported. Use an exact Workday or Oracle Recruiting job URL; direct Greenhouse applications need no account.',{exact:true}).waitFor();
  assert.equal(Object.keys(JSON.parse(await readFile(join(root,'employer-accounts.json'),'utf8')).accounts).length,0);
  await accountsWorkspace.getByLabel('Exact employer portal URL',{exact:true}).fill('https://acme.wd5.myworkdayjobs.com/en-US/jobs/one');
  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  await accountsWorkspace.getByText('Workday realm',{exact:true}).waitFor();
  await accountsWorkspace.getByText('Keychain setup pending',{exact:true}).waitFor();
  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  const unrelatedDraft='https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/331081';
  await accountsWorkspace.getByLabel('Exact employer portal URL',{exact:true}).fill(unrelatedDraft);
  await accountsWorkspace.getByRole('button',{name:'Add MyGreenhouse',exact:true}).click();
  await accountsWorkspace.getByText('Global account',{exact:true}).waitFor();
  await accountsWorkspace.getByRole('button',{name:'Add portal',exact:true}).click();
  assert.equal(await accountsWorkspace.getByLabel('Exact employer portal URL',{exact:true}).inputValue(),unrelatedDraft);
  await accountsWorkspace.getByRole('button',{name:'Cancel',exact:true}).click();
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
  return {settings:true,redactedRealm:true,removal:true,idleRecovery:true,trustedFillStatus:true,layouts:[390,1280],liveExecutionDisabled:true};
}
