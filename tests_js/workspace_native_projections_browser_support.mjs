import { clickCompanionNav } from './workspace_companion_nav_support.mjs';
import assert from 'node:assert/strict';

export async function projectionsBrowser(page, {jobId, markReady}) {

  const overview=await page.evaluate(async()=>{
    const token=new URLSearchParams(location.hash.slice(1)).get('token');
    return (await fetch('/api/overview',{headers:{Authorization:`Bearer ${token}`}})).json();
  });
  const readySetup=()=>page.route('**/api/overview',async route=>{
    const response=await route.fetch();const current=await response.json();
    await route.fulfill({json:{...current,setup:{...current.setup,hasResume:true,hasProfileFacts:true}}});
  });
  await readySetup();
  await clickCompanionNav(page, 'Applications');
  await page.getByRole('button',{name:'Refresh applications',exact:true}).click();
  await page.getByRole('button',{name:/^Completed \(/}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Open Needs Attention',exact:true}).count(),0);
  assert.equal(await page.getByRole('region',{name:'Get ready to apply',exact:true}).count(),0);
  await page.getByRole('button',{name:/^Completed \(/}).click();
  await page.getByRole('region',{name:'Completed applications',exact:true}).waitFor();
  await page.getByRole('button',{name:'Active',exact:true}).click();
  for(const setup of [{hasResume:false,hasProfileFacts:false},{hasResume:true,hasProfileFacts:false}]) {
    await page.route('**/api/overview',async route=>{
      await route.fulfill({json:{...overview,setup:{...overview.setup,...setup}}});
    });
    await page.getByRole('button',{name:'Refresh applications',exact:true}).click();
    await page.getByRole('region',{name:'Get ready to apply',exact:true}).waitFor();
    await page.getByRole('button',{name:setup.hasResume?'Review facts':'Add resume',exact:true}).waitFor();
    assert.equal(await page.getByRole('region',{name:'Needs Attention',exact:true}).count(),0);
    await page.unroute('**/api/overview');await readySetup();
  }
  await page.getByRole('button',{name:'Refresh applications',exact:true}).click();
  await page.getByRole('region',{name:'Needs Attention',exact:true}).waitFor();
  await page.route('**/api/overview',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":{"message":"Synthetic outage"}}'}));
  await page.getByRole('button',{name:'Refresh applications',exact:true}).click();
  await page.getByText(/Showing the last loaded information/).waitFor();
  await page.unroute('**/api/overview');await readySetup();
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByText(/Showing the last loaded information/).waitFor({state:'hidden'});
  const attention = page.getByRole('region', {name:'Needs Attention',exact:true});
  await attention.getByRole('button', {name:`Review job ${jobId}`,exact:true}).waitFor();
  await attention.getByLabel('Filter by reason').selectOption('expired_agent_attempt');
  await attention.getByText('No jobs match this reason filter.',{exact:true}).waitFor();
  await attention.getByLabel('Filter by reason').selectOption('');
  await attention.getByRole('button', {name:`Review job ${jobId}`,exact:true}).click();
  const homeReload=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');
  const countBefore=Number(await page.locator('#workspace-navigation button[aria-label="Applications"] .nav-count').textContent());
  await attention.getByRole('button',{name:'Snooze for 1 day',exact:true}).click();
  await homeReload;
  await page.waitForFunction(count=>document.querySelector('#workspace-navigation button[aria-label="Applications"] .nav-count')?.textContent?.trim()===String(count),countBefore-1);
  await attention.getByRole('button',{name:`Review job ${jobId}`,exact:true}).waitFor({state:'hidden'});
  await attention.getByLabel('Show snoozed',{exact:true}).check();
  await attention.getByRole('button',{name:`Review job ${jobId}`,exact:true}).click();
  await attention.getByRole('button',{name:'Unsnooze',exact:true}).click();
  await attention.getByRole('button',{name:'Snooze for 1 day',exact:true}).waitFor();
  await attention.getByLabel('Show snoozed',{exact:true}).uncheck();
  let releaseJob;
  let requested;
  const requestStarted=new Promise(resolve=>{requested=resolve;});
  const holdJob=new Promise(resolve=>{releaseJob=resolve;});
  await page.route(`**/api/jobs/${jobId}`,async route=>{requested();await holdJob;await route.continue();});
  await attention.getByRole('button', {name:`Open job ${jobId}`,exact:true}).click();
  await requestStarted;
  await page.getByRole('button',{name:'New job',exact:true}).click();
  await page.locator('dialog [name="role"]').fill('Keep this intervening draft');
  const openedResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/jobs/${jobId}`);
  releaseJob();await openedResponse;
  await page.waitForTimeout(100);
  assert.equal(await page.locator('dialog [name="role"]').inputValue(),'Keep this intervening draft');
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Close job details',exact:true}).click();
  await page.unroute(`**/api/jobs/${jobId}`);
  await clickCompanionNav(page,'Applications');
  await attention.getByRole('button', {name:`Open job ${jobId}`,exact:true}).click();
  const modal = page.locator('dialog.job-drawer');
  await modal.waitFor();
  const activity = modal.getByRole('region',{name:'Job activity',exact:true});
  await activity.getByText(/Status: needs info/i).waitFor();
  await activity.getByText('No history recorded for this job.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.route('**/api/jobs/*/activity',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  await activity.getByRole('button',{name:'Refresh activity',exact:true}).click();
  await activity.getByText(/last loaded job data/).waitFor();
  await page.unroute('**/api/jobs/*/activity');
  await activity.getByRole('button',{name:'Refresh activity',exact:true}).click();
  await activity.getByText(/last loaded job data/).waitFor({state:'hidden'});
  await modal.getByRole('button',{name:'Edit job',exact:true}).click();
  await modal.locator('[name="notes"]').fill('Projection navigation draft');
  page.once('dialog',dialog=>dialog.dismiss());
  await modal.getByRole('button',{name:'Close job details',exact:true}).click();
  assert.equal(await modal.locator('[name="notes"]').inputValue(),'Projection navigation draft');
  page.once('dialog',dialog=>dialog.accept());
  await modal.getByRole('button',{name:'Close job details',exact:true}).click();
  await clickCompanionNav(page, 'Needs Attention');
  await attention.getByRole('button',{name:`Review job ${jobId}`,exact:true}).waitFor();
  await markReady();
  await page.getByRole('button',{name:'Refresh applications',exact:true}).click();
  await attention.getByRole('button',{name:`Review job ${jobId}`,exact:true}).waitFor({state:'hidden'});
  // The preceding Answers walkthrough deliberately retains another unresolved job.
  await attention.getByRole('button',{name:'Review job pending-browser-job',exact:true}).waitFor();
  await clickCompanionNav(page, 'Overview');
  await page.getByRole('heading',{name:'Applications',exact:true}).waitFor();
  await page.unrouteAll({behavior:'wait'});
  return {overview:true,attention:true,activity:true,staleRetry:true,resolvedAttention:true};
}
