const groups = { overview: 'pipeline', jobs: 'pipeline', attention: 'pipeline', facts: 'application-data', resumes: 'application-data', answers: 'application-data', automation: 'controls', trash: 'controls' };
export async function openWorkspaceMenu(page, name) {
  const mobile = page.locator('#workspace-menu-toggle');
  if (await mobile.isVisible() && await mobile.getAttribute('aria-expanded') === 'false') await mobile.click();
  const group = page.locator(`#nav-group-${groups[name]}`);
  if (await group.getAttribute('aria-expanded') === 'false') await group.click();
}
export async function openWorkspace(page, name) {
  await openWorkspaceMenu(page, name);
  await page.locator(`#nav-${name}`).click();
}
