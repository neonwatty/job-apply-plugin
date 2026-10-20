export async function clickCompanionNav(page, label) {
  const nav = page.getByRole('navigation', { name: 'Workspace sections' });
  const group=['Facts','Resumes','Answers','Consent defaults'].includes(label)?'My information'
    : ['Automation','Accounts & Sign-in','Settings','Trash'].includes(label)?'Settings':null;
  if(group){const details=nav.locator('details').filter({hasText:group});
    if(await details.count() && await details.getAttribute('open')===null) await details.locator('summary').click();}
  const labels=({Overview:['Overview','Applications'],'Needs Attention':['Needs Attention','Applications'],Jobs:['Jobs','Saved jobs']})[label] ?? [label];
  await nav.locator(labels.map(value=>`button.nav-link[aria-label="${value}"]`).join(',')).click();
}
