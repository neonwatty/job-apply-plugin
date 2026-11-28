export async function clickCompanionNav(page, label) {
  const phone = page.getByRole('navigation', { name: 'Mobile workspace sections', exact: true });
  const nav = page.getByRole('navigation', { name: 'Workspace sections', exact: true });
  const options = { name: label, exact: true };
  if (!await phone.isVisible()) return nav.getByRole('button', options).click();
  if (['Needs Attention', 'Jobs', 'More'].includes(label)) return phone.getByRole('button', options).click();
  await phone.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('navigation', { name: 'More workspace sections', exact: true }).getByRole('button', options).click();
}

export function jobDetailBack(dialog) {
  return dialog.getByRole('button', { name: /^(Close job details|Back to Jobs|Back to Needs Attention)$/ });
}
