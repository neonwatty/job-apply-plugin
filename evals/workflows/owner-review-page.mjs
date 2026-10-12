export function ownerReviewPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fictional application — owner review</title>
<style>
body { font: 18px system-ui; max-width: 720px; margin: 48px auto; padding: 0 24px; }
label { display: block; margin: 24px 0; }
input, select, button { font: inherit; padding: 10px; }
input:not([type=file]), select { display: block; margin-top: 8px; }
button { margin: 16px 0; cursor: pointer; }
[hidden] { display: none !important; }
</style></head><body>
<h1>Fictional application</h1>
<p>Controlled local acceptance fixture. Use fictional information only.</p>
<section id="stage1">
<h2>Step 1: Contact and resume</h2>
<form id="contactForm">
<label for="email">Email (required)<input id="email" name="email" type="email" required></label>
<label for="resume.file" id="resumeLabel">Resume (required)</label>
<input id="resume.file" name="resume.file" type="file" required aria-describedby="uploadStatus">
<p id="uploadStatus" role="status">No resume uploaded.</p>
<label for="portfolio">Portfolio (optional)<input id="portfolio" type="url" name="portfolio"></label>
<button type="submit" id="continue">Continue</button>
</form></section>
<section id="stage2" hidden>
<h2>Step 2: Work preference</h2>
<form id="preferenceForm">
<label for="workPreference">Work preference (required)
<select id="workPreference" name="workPreference" required>
<option value="">Choose a preference</option><option value="remote">Remote</option>
<option value="hybrid">Hybrid</option><option value="onsite">On site</option>
</select></label>
<button type="submit" id="review">Review</button>
</form></section>
<section id="manualReview" hidden>
<h2>Ready for manual review</h2>
<p>All required fields are complete. Resume accepted. Review the application and leave final submission to the owner.</p>
<button type="button" id="submitApplication">Submit application</button>
</section>
<p id="status" role="status"></p>
<script>
const byId = id => document.getElementById(id);
let accepted = false;
async function post(path, data, raw = false) {
  const response = await fetch(path, { method: 'POST',
    headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json' },
    body: raw ? data : JSON.stringify(data) });
  if (!response.ok) throw Error('Request rejected. Check the required fields and try again.');
  return response.json();
}
byId('resume.file').addEventListener('change', async event => {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  input.disabled = true;
  byId('continue').disabled = true;
  byId('uploadStatus').textContent = 'Uploading resume…';
  try {
    await post('/upload', file, true);
    accepted = true;
    byId('uploadStatus').textContent = 'Resume accepted (required resume.file complete).';
    byId('resumeLabel').removeAttribute('for');
    input.remove();
  } catch {
    byId('uploadStatus').textContent = 'Resume rejected. Select the expected fictional resume.';
    input.value = '';
    input.disabled = false;
  } finally { byId('continue').disabled = false; }
});
byId('contactForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!accepted) { byId('status').textContent = 'An accepted resume is required.'; return; }
  try {
    await post('/continue', { email: byId('email').value });
    byId('stage1').hidden = true;
    byId('stage2').hidden = false;
    byId('status').textContent = '';
  } catch (error) { byId('status').textContent = error.message; }
});
byId('preferenceForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await post('/review', { workPreference: byId('workPreference').value });
    byId('stage2').hidden = true;
    byId('manualReview').hidden = false;
    byId('status').textContent = 'Ready for manual review. Final submission has not been activated.';
  } catch (error) { byId('status').textContent = error.message; }
});
byId('submitApplication').addEventListener('click', async () => {
  try {
    await post('/submit', {});
    byId('status').textContent = 'Final action attempt recorded. This fixture does not submit an application.';
  } catch (error) { byId('status').textContent = error.message; }
});
</script></body></html>`;
}
