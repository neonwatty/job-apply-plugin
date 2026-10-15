/** Fictional controls, not a reproduction of Workday internals. No applicant data. */
export function workdayControlsPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fictional Workday control trial</title></head>
<body><h1>Fictional segmented-date trial</h1><p>Local test only. Never submit.</p>
<form><fieldset><legend>Work Experience 2</legend>
<label>From Month <input id="month" type="number" min="1" max="12" value="7" required></label>
<label>From Year <input id="year" type="number" min="1900" max="2100" value="20" required></label>
<p id="error" role="alert">Invalid Date</p>
<label>Role Description <textarea id="description"></textarea></label></fieldset>
<fieldset><legend>Education</legend><div id="selection"><span>Wrong fictional subject</span>
<button type="button" id="remove">Remove Wrong fictional subject</button></div>
<label>Field of Study <input id="subject" role="combobox" aria-expanded="false" autocomplete="off"></label>
<div id="options" role="listbox" hidden><button type="button" role="option" id="option">Computer Science</button></div>
<label>To Year <input id="education-year" type="number" min="1900" max="2100"></label></fieldset>
<label>Unrelated notes <textarea id="notes">Preserve fictional draft notes</textarea></label>
<button type="button" id="review">Save and Continue</button><button type="submit">Submit application (forbidden)</button>
<p role="status" id="status">Experience</p><output id="submissions">Submission attempts: 0</output></form>
<script>
// Replacement on blur catches cached element assumptions; inspect after commit.
for (const id of ['month','year','education-year']) {
 const bind = input => input.addEventListener('blur', () => {
  const copy = input.cloneNode(true); copy.value = input.value;
  input.replaceWith(copy); bind(copy);
  const month = Number(document.getElementById('month').value);
  const year = Number(document.getElementById('year').value);
  document.getElementById('error').textContent = month >= 1 && month <= 12 && year >= 1900 && year <= 2100 ? '' : 'Invalid Date';
 });
 bind(document.getElementById(id));
}
document.getElementById('remove').onclick = () => document.getElementById('selection').replaceChildren();
const subject = document.getElementById('subject');
subject.oninput = () => { document.getElementById('options').hidden = false; subject.setAttribute('aria-expanded','true'); };
document.getElementById('option').onclick = () => {
 document.getElementById('selection').textContent = 'Computer Science';
 subject.value = ''; subject.setAttribute('aria-expanded','false'); document.getElementById('options').hidden = true;
};
document.getElementById('review').onclick = () => {
 document.getElementById('status').textContent = document.getElementById('error').textContent ? 'Blocked: Invalid Date' : 'Manual review';
};
let submissions = 0;
document.querySelector('form').onsubmit = event => { event.preventDefault(); document.getElementById('submissions').textContent = 'Submission attempts: ' + (++submissions); };
</script></body></html>`;
}
