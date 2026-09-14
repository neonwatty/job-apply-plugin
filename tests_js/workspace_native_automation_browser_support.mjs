import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function nativeAutomationBrowser(page, root) {
  await page.getByRole('button',{name:'Automation',exact:true}).click();
  const workspace=page.locator('.automation-workspace');
  await workspace.getByRole('heading',{name:'Account controls that fail closed.',exact:true}).waitFor();
  await workspace.getByText(/native provider not composed/).waitFor();
  await workspace.locator('.automation-metrics').getByText('Live execution',{exact:true}).waitFor();
  assert.equal(await workspace.getByRole('button',{name:'Mark stranded operation ambiguous',exact:true}).isDisabled(),true);

  await workspace.getByLabel(/Enable companion automation controls/).check();
  await workspace.getByRole('button',{name:'Save settings',exact:true}).click();
  await workspace.getByText('Automation settings saved.',{exact:true}).waitFor();
  const settings=JSON.parse(await readFile(join(root,'automation-settings.json'),'utf8')).settings;
  assert.equal(settings.enabled,true);
  assert.equal(settings.revision,2);

  const privateEmail='private-native-automation@example.invalid';
  await workspace.getByLabel('Exact employer portal URL',{exact:true}).fill('https://acme.wd5.myworkdayjobs.com/en-US/jobs/one');
  await workspace.getByLabel('Optional signup email override',{exact:true}).fill(privateEmail);
  await workspace.getByRole('button',{name:'Add resolved realm',exact:true}).click();
  await workspace.getByRole('form',{name:/Edit signup email override for Workday realm/}).waitFor();
  assert.equal(await workspace.getByRole('listitem').count(),1);
  assert.doesNotMatch(await workspace.innerText(),new RegExp(privateEmail));
  const accounts=JSON.parse(await readFile(join(root,'employer-accounts.json'),'utf8')).accounts;
  assert.equal(Object.values(accounts)[0].signupEmailOverride,privateEmail);

  await workspace.getByLabel('Job ID for status or revocation',{exact:true}).fill('missing-job');
  await workspace.getByRole('button',{name:'Check approval status',exact:true}).click();
  await workspace.getByText('No approval exists for this job.',{exact:true}).waitFor();
  for (const width of [390,1280]) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  }
  return {settings:true,redactedRealm:true,idleRecovery:true,trustedFillStatus:true,layouts:[390,1280],liveExecutionDisabled:true};
}
