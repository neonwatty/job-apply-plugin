import assert from 'node:assert/strict';
export async function checkSidebar(page, output) {
  const toggle=page.locator('.sidebar-toggle');
  const nav=page.getByRole('navigation',{name:'Workspace sections'});
  for(const width of [1440,1024,760,390,320]) {
    await page.setViewportSize({width,height:900});
    await toggle.focus();
    await page.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert(await toggle.evaluate(node=>node===document.activeElement),'toggle retains keyboard focus');
    const samples=await page.evaluate(async()=>{
      const frames=[],started=performance.now();
      while(performance.now()-started<350) {
        await new Promise(requestAnimationFrame);
        frames.push({width:document.querySelector('.topbar').getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth});
      }
      return frames;
    });
    assert(samples.every(frame=>!frame.overflow),`transition overflow at ${width}`);
    if(width>760) {
      assert(Math.abs(samples.at(-1).width-76)<1,`collapsed rail width at ${width}: ${JSON.stringify(samples)}`);
      assert(samples.some(frame=>frame.width>76 && frame.width<238),'width animates');
    }
    assert.equal(await page.locator('.topbar').evaluate(node=>getComputedStyle(node).backdropFilter),'none',
      'rail must not create a clipping containing block for fixed tooltip labels');
    await nav.getByRole('button',{name:'Needs Attention',exact:true}).focus();
    await page.waitForTimeout(160);
    assert.equal(await nav.getByRole('button',{name:'Needs Attention',exact:true}).getAttribute('title'),'Needs Attention');
    assert.equal(await nav.getByRole('button',{name:'Needs Attention',exact:true}).locator('.nav-label').evaluate(node=>getComputedStyle(node).opacity),'1');
    await page.keyboard.press('Enter');
    await page.locator('.focus-item').first().waitFor();
    await page.mouse.move(width-20,400);
    await page.waitForTimeout(180);
    await page.screenshot({path:`${output}/sidebar-collapsed-${width}.png`,fullPage:true});
    for(const label of ['Jobs','Facts','Resumes','Answers','Consent defaults','Automation','Accounts & Sign-in','Settings','Trash']) {
      await nav.getByRole('button',{name:label,exact:true}).click();
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${label} collapsed overflow at ${width}`);
    }
    await toggle.click();
    await page.waitForTimeout(260);
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`expanded overflow at ${width}`);
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.emulateMedia({reducedMotion:'reduce'});
  await toggle.click();
  assert(await page.locator('.topbar').evaluate(node=>parseFloat(getComputedStyle(node).transitionDuration)<0.001),'reduced motion disables visible animation');
  await toggle.click();
  await page.emulateMedia({reducedMotion:'no-preference'});
  await nav.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByText('Advanced agent model defaults',{exact:true}).click();
  const model=page.getByLabel('Codex job search task model',{exact:true});
  await model.fill('sidebar-draft');
  await toggle.click();
  await toggle.click();
  assert.equal(await model.inputValue(),'sidebar-draft');
  page.once('dialog',dialog=>dialog.accept());
  await nav.getByRole('button',{name:'Jobs',exact:true}).click();
  console.log('Sidebar: keyboard, destinations, transitions, five widths, drafts and reduced motion passed.');
}
