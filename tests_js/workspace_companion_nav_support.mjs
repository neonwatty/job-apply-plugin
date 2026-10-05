const materials = new Set(['Facts', 'Resumes', 'Answers', 'Consent defaults']);
const more = new Set(['Automation', 'Accounts & Sign-in', 'Settings', 'Trash']);

export async function clickCompanionNav(page, label) {
  const nav = page.getByRole('navigation', { name: 'Workspace sections' });
  if (!await nav.isVisible()) await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const target = nav.getByRole('button', { name: label, exact: true });
  if (!await target.isVisible()) {
    const group = materials.has(label) ? 'Materials' : more.has(label) ? 'More' : null;
    if (!group) throw Error(`Unknown Companion destination: ${label}`);
    await nav.getByRole('button', { name: group, exact: true }).click();
  }
  await target.click();
}
