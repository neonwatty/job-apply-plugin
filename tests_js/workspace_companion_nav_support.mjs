export async function clickCompanionNav(page, label) {
  const nav = page.getByRole('navigation', { name: 'Workspace sections' });
  // Native-only destinations appear after boot; click waits for that boundary.
  await nav.getByRole('button', { name: label, exact: true }).click();
}
