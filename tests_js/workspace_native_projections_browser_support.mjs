import { clickCompanionNav } from './workspace_companion_nav_support.mjs';
import assert from 'node:assert/strict';

export async function projectionsBrowser(page, {markReady}) {

  await clickCompanionNav(page, 'Overview');
  await page.getByRole('heading', {name:'Your next move, at a glance.',exact:true}).waitFor();
  await page.getByRole('button', {name:'Open Needs Attention',exact:true}).waitFor();
  assert.equal(await page.getByRole('link', {name:'Edit Facts',exact:true}).count(),0);
  await page.getByRole('button', {name:'Manage Resumes',exact:true}).click();
  await page.getByRole('button', {name:'Import resume',exact:true}).waitFor();
  await clickCompanionNav(page, 'Overview');
  await page.getByRole('button', {name:'Open Needs Attention',exact:true}).waitFor();
  await page.route('**/api/overview',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":{"message":"Synthetic outage"}}'}));
  await page.getByRole('button', {name:'Refresh overview',exact:true}).click();
  await page.getByText(/Showing the last loaded overview/).waitFor();
  await page.unroute('**/api/overview');
  await page.getByRole('button', {name:'Retry overview',exact:true}).click();
  await page.getByText(/Showing the last loaded overview/).waitFor({state:'hidden'});
  await page.getByRole('button', {name:'Open Needs Attention',exact:true}).click();
  const attention = page.getByRole('region', {name:'Needs Attention',exact:true});
  const queueJob = attention.getByRole('button', {name:/CLI writer Native fixture role Needs information/});
  await queueJob.waitFor();
  await attention.getByLabel('Filter by reason').selectOption('expired_agent_attempt');
  await attention.getByText('No jobs match this reason filter.',{exact:true}).waitFor();
  await attention.getByLabel('Filter by reason').selectOption('');
  await queueJob.click();
  await attention.getByRole('button', {name:'See what’s missing',exact:true}).click();
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
  await queueJob.waitFor();
  await markReady();
  await attention.getByRole('button',{name:'Refresh attention',exact:true}).click();
  await queueJob.waitFor({state:'hidden'});
  // The preceding Answers walkthrough deliberately retains another unresolved job.
  await attention.getByRole('button',{name:/Pending fixture company Pending fixture role Needs information/}).waitFor();
  await clickCompanionNav(page, 'Overview');
  await page.getByRole('button',{name:'Open Needs Attention',exact:true}).waitFor();
  return {overview:true,attention:true,activity:true,staleRetry:true,resolvedAttention:true};
}
