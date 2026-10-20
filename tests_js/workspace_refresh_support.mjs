// Headers can arrive before Response.json() and the refresh coordinator finish.
// Observe a new completion announcement, including when its text is unchanged.
export async function refreshJobsAndWait(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const toast = document.querySelector('#toast');
    const observer = new MutationObserver(() => {
      if (toast.textContent !== 'Jobs refreshed from the canonical store') return;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Jobs refresh did not complete'));
    }, 10_000);
    observer.observe(toast, { childList: true, characterData: true, subtree: true });
    document.querySelector('#refresh').click();
  }));
}
