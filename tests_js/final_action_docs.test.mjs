import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const safetyContext = /\b(?:never|do not|don't|cannot|can't|must not|may not|should not|blocked|disabled|forbidden|review[_ -]only|manual(?:ly)?|untouched|stop(?:s|ped|ping)?\s+(?:at|before)|leave(?:s|ing)?\s+[^.]*\buntouched)\b/i;
const directActionSafety = /\b(?:never|do not|don't|cannot|can't|must not|may not|should not)\s+(?:click|activate|submit|send|apply)\b/i;
const leadingFinalAction = /^\s*(?:(?:[-*+]\s+)|(?:\d+[.)]\s+))?(?:\*{1,2})?(?:submit|send)\b/i;
const clickFinalControl = /\b(?:click|activate)(?:s|ed|ing)?\b[^.!?\n]{0,80}\b(?:submit|send|apply|final[ -]action)(?:\s+(?:button|control|action))?\b/i;
const directFinalAction = /\b(?:submit|send)(?:s|ted|ting)?\b[^.!?\n]{0,50}\b(?:application|form)\b|\bappl(?:y|ies|ied|ying)\b[^.!?\n]{0,50}\b(?:now|automatically)\b/i;
const easyApplyEntryLabel = /(?:(?<quote>['"`])Easy Apply\k<quote>|Easy Apply)(?=\s+(?:button|link)\b[^.!?\n]{0,80}\b(?:to\s+open|for\s+opening)\s+(?:the\s+)?(?:(?:application\s+)?modal|application\s+form)\b)/gi;
const clauseBreak = /[;.!?]+|,\s+(?=(?:(?:but|however)\s+)?(?:click|activate)\b|(?:but|however)\b|(?:do not|don't|never|must not|may not|should not)\b)/i;

function actionable(line) {
  const text = line.replace(/^\s{0,3}#{1,6}\s+/, '');
  return leadingFinalAction.test(text)
    || clickFinalControl.test(text.replace(easyApplyEntryLabel, 'application-entry'))
    || directFinalAction.test(text);
}

function violations(text) {
  return text.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/).flatMap((line, index) => {
    const clauses = line.trim().split(clauseBreak).filter(actionable);
    const unsafe = clauses.some(clause => !safetyContext.test(clause))
      || (clauses.length === 0 && actionable(line) && !directActionSafety.test(line));
    return unsafe ? [{ line: index + 1, text: line.trim() }] : [];
  });
}

test('Job Apply skill and its references preserve manual submission instructions', async () => {
  const skill = new URL('../skills/job-apply/', import.meta.url);
  const entries = await readdir(skill, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.md'))) {
    const file = join(entry.parentPath, entry.name);
    assert.deepEqual(violations(await readFile(file, 'utf8')), [], file);
  }
});

test('final-action instruction check accepts manual review and rejects unguarded final actions', () => {
  for (const safe of [
    "## Auto-submit policy boundary",
    "Every live Submit, Send, Apply, or equivalent final action remains blocked.",
    "Stop before the final action and leave the Submit button untouched.",
    "The user submits the application manually.",
    "Do not click Submit application.",
    "Do not click this control; it is the Submit button.",
    "Click Easy Apply button to open the modal.",
    "Click \"Easy Apply\" button to open the application modal.",
    "Click 'Easy Apply' link to open the application form.",
    "Click `Easy Apply` button for opening the application form.",
  ]) {
    assert.deepEqual(violations(safe), [], safe);
  }
  for (const unsafe of [
    "Click Submit application.",
    "Click Apply button.",
    "Activate the final-action control.",
    "Submit the application.",
    "Send the application now.",
    "Apply now.",
    "Apply automatically.",
    "Click the final-action control.",
    "The assistant should click the Submit button.",
    "The automation submits the application automatically.",
    "Click \"Apply\" button to open the application form.",
    "Click \"Quick Apply\" button to open the application form.",
    "Click \"Easy Apply\" button.",
    "Click \"Easy Apply\" button to inspect the page.",
    "Click 'Easy Apply\" button to open the application form.",
    "## Submit applications automatically",
    "Do not wait; click Submit application.",
    "Click Submit application; do not ask again.",
    "Do not wait, click Submit application.",
    "Click Submit application, but do not ask again.",
    "Never hesitate; click Apply button.",
    "Apply now, do not ask again.",
    "Click this control; the control is labeled Apply button.",
    "Activate this control; it is the final-action control.",
    "Click this control; it is the Submit button; do not wait.",
  ]) {
    assert.equal(violations(unsafe).length, 1, unsafe);
  }
  for (const lineEnding of ["\n", "\r\n", "\r", "\u0085", "\u2028", "\u2029"]) {
    assert.deepEqual(violations(["Manual review", "", "Click Submit application."].join(lineEnding)), [
      { line: 3, text: "Click Submit application." },
    ]);
  }
});
