import { openWorkspace } from "./workspace_menu_support.mjs";
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createOwnerBetaScenario, startOwnerBetaScenario, cleanupOwnerBetaScenario,
} from './workspace_owner_beta_scenario_support.mjs';
test("guided setup reaches Ready and survives restart", { timeout: 90_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await startOwnerBetaScenario(context);
    const page = await context.browser.newPage();
    await page.goto(context.running.startup.url);
    await page.getByRole('button',{name:'Open Resumes',exact:true}).click();
    const form = page.locator('#resume-import');
    await form.getByLabel('Label',{exact:true}).fill('Setup example');
    const source = 'Ada Example\nada@example.invalid\nSoftware Engineer\nSkills: Python, JavaScript\n';
    await form.locator('input[type=file]').setInputFiles({
      name: 'setup-example.txt', mimeType: 'text/plain', buffer: Buffer.from(source),
    });
    await form.getByRole('button',{name:'Import resume',exact:true}).click();
    await page.getByRole('button',{name:'Request fact extraction',exact:true}).first().click();
    await page.getByRole('button',{name:'Copy agent handoff',exact:true}).first().waitFor();
    const [request] = await context.cli('resume-extraction-request-list',['--status','requested']);
    const resolved = await context.cli('resume-resolve',['--id',request.resumeId]);
    assert.equal(await readFile(resolved.path,'utf8'),source);
    const profile = await context.cli('profile-inspect');
    // Prepared candidate tests the handoff contract; it does not measure agent extraction.
    const completion = await context.cli('resume-extraction-request-complete', [
      '--id', request.requestId,
      '--expected-request-revision', String(request.revision),
      '--expected-profile-revision', String(profile.revision),
    ], {
      firstName: 'Ada', lastName: 'Example', email: 'ada@example.invalid',
      skills: ['Python', 'JavaScript'],
    });
    assert.equal(completion.request.status,'completed');
    assert.equal(completion.proposalSummary.pendingCount,0);
    await openWorkspace(page, "facts");
    await page.waitForFunction(() =>
      document.querySelector('#facts-workspace input[data-path="/firstName"]')?.value === 'Ada');
    assert.equal(await page.locator('#facts-workspace input[data-path="/firstName"]').inputValue(),'Ada');
    await openWorkspace(page, "jobs");
    await page.getByRole('button',{name:'New job',exact:true}).click();
    const dialog = page.locator('#job-dialog');
    await dialog.getByLabel('Job URL',{exact:true}).fill('https://example.invalid/jobs/setup');
    await dialog.getByLabel('Role',{exact:true}).fill('Setup Engineer');
    await dialog.getByLabel('Company',{exact:true}).fill('Example');
    await dialog.getByRole('button',{name:'Save job',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    await page.getByRole('button',{name:/Setup Engineer/}).click();
    await dialog.getByRole('button',{name:'Run ready check',exact:true}).click();
    await page.locator('#preflight-panel').waitFor();
    await dialog.getByText('No blocking issues').waitFor();
    await dialog.getByRole('button',{name:'Mark ready',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    await openWorkspace(page, "overview");
    await page.getByRole('heading',{name:'Hand off a ready job',exact:true}).waitFor();
    await context.stop(context.running.child);
    context.running = await context.launch();
    await page.goto(context.running.startup.url);
    await page.getByRole('heading',{name:'Hand off a ready job',exact:true}).waitFor();
  } finally {
    await cleanupOwnerBetaScenario(context);
  }
});
