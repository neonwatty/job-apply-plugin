import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fixture, ReplayEvent } from './contracts.js';
import { ReplayError } from './contracts.js';

const assertions = ['required-fields-filled', 'resume-uploaded', 'resume-filename-matched', 'review-reached',
  'history-started-reviewed', 'history-not-completed', 'session-present', 'session-value-free', 'final-action-untouched'] as const;
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function forbiddenValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenValue);
  return object(value) && (Object.hasOwn(value, 'value') || Object.values(value).some(forbiddenValue));
}
function evaluateEvents(fixture: Fixture, events: ReplayEvent[]): { filled: Set<string>; uploaded: Set<string>; reviewed: boolean; finalAction: boolean; filenames: boolean } {
  if (!Array.isArray(events) || events.length > 10000) throw new ReplayError('invalid events');
  const controls = new Map(fixture.steps.flatMap(step => step.controls.map(control => [control.id, { control, stepId: step.id }] as const)));
  const steps = new Map(fixture.steps.map(step => [step.id, step]));
  const filled = new Set<string>(), uploaded = new Set<string>(); let reviewed = false, finalAction = false, filenames = true;
  for (const event of events) {
    if (!object(event) || typeof event.type !== 'string' || typeof event.stepId !== 'string') throw new ReplayError('invalid event');
    if (event.type === 'final-action') { if (Object.keys(event).length !== 2 || steps.get(event.stepId)?.kind !== 'review') throw new ReplayError('invalid event'); finalAction = true; continue; }
    if (typeof event.controlId !== 'string') throw new ReplayError('invalid event');
    const entry = controls.get(event.controlId), step = steps.get(event.stepId);
    if (event.type === 'filled' && entry?.stepId === event.stepId && entry.control.role !== 'file') filled.add(event.controlId);
    else if (event.type === 'uploaded' && entry?.stepId === event.stepId && entry.control.role === 'file' && typeof event.expectedFilenameMatched === 'boolean') {
      uploaded.add(event.controlId); filenames = filenames && event.expectedFilenameMatched;
    } else if (event.type === 'validation' && entry?.stepId === event.stepId) continue;
    else if (event.type === 'advanced' && event.controlId === '' && step?.kind === 'form') continue;
    else if (event.type === 'reviewed' && event.controlId === '' && step?.kind === 'review') reviewed = true;
    else throw new ReplayError('invalid event');
  }
  return { filled, uploaded, reviewed, finalAction, filenames };
}
async function storeEvidence(root: string): Promise<{ lifecycle: boolean; notCompleted: boolean; historyCategory: string | null; session: boolean; valueFree: boolean; sessionArtifact: boolean }> {
  let text: string; try { text = await readFile(join(root, 'applications.jsonl'), 'utf8'); } catch { return { lifecycle: false, notCompleted: true, historyCategory: 'history-missing', session: false, valueFree: true, sessionArtifact: false }; }
  const rows = text.split(/\r?\n/).filter(Boolean); if (rows.length > 10000) throw new ReplayError('invalid history artifact');
  const events: Record<string, unknown>[] = [];
  try { for (const row of rows) { const value = JSON.parse(row) as unknown; if (!object(value) || typeof value.applicationId !== 'string' || typeof value.event !== 'string') throw new Error(); events.push(value); } }
  catch { throw new ReplayError('invalid history artifact'); }
  const started = new Map<string, number>(), reviewed = new Set<string>(); let completed = false;
  events.forEach((event, index) => { const id = event.applicationId as string, kind = event.event as string;
    if (kind === 'started' && !started.has(id)) started.set(id, index); if (kind === 'reviewed' && (started.get(id) ?? Infinity) < index) reviewed.add(id); if (kind === 'completed') completed = true; });
  let names: string[]; try { names = (await readdir(join(root, 'sessions'))).filter(name => name.endsWith('.json')); } catch { names = []; }
  if (names.length > 256) throw new ReplayError('invalid session artifacts');
  let correlated = false, valueFree = true;
  for (const name of names) {
    let value: unknown; try { value = JSON.parse(await readFile(join(root, 'sessions', name), 'utf8')) as unknown; } catch { throw new ReplayError('invalid session artifact'); }
    if (forbiddenValue(value)) valueFree = false;
    if (object(value) && typeof value.applicationId === 'string' && reviewed.has(value.applicationId)) correlated = true;
  }
  return { lifecycle: reviewed.size > 0, notCompleted: !completed, historyCategory: reviewed.size ? null : 'history-lifecycle-incomplete', session: correlated, valueFree, sessionArtifact: names.length > 0 };
}
export async function evaluateRun(fixture: Fixture, scenarioId: string, events: ReplayEvent[], storeRoot: string): Promise<Record<string, unknown>> {
  const observed = evaluateEvents(fixture, events), evidence = await storeEvidence(storeRoot);
  const requiredFields = fixture.steps.flatMap(step => step.controls).filter(control => control.required && control.role !== 'file').map(control => control.id);
  const requiredFiles = fixture.steps.flatMap(step => step.controls).filter(control => control.required && control.role === 'file').map(control => control.id);
  const missingFields = requiredFields.filter(id => !observed.filled.has(id)), missingFiles = requiredFiles.filter(id => !observed.uploaded.has(id));
  const checks: Record<(typeof assertions)[number], boolean> = { 'required-fields-filled': !missingFields.length, 'resume-uploaded': !missingFiles.length,
    'resume-filename-matched': !missingFiles.length && observed.filenames, 'review-reached': observed.reviewed,
    'history-started-reviewed': evidence.lifecycle, 'history-not-completed': evidence.notCompleted, 'session-present': evidence.session,
    'session-value-free': evidence.valueFree, 'final-action-untouched': !observed.finalAction };
  const categories = new Set<string>(); if (missingFields.length) categories.add('required-fields-missing'); if (missingFiles.length) categories.add('required-upload-missing');
  if (!missingFiles.length && !observed.filenames) categories.add('resume-filename-mismatch'); if (!observed.reviewed) categories.add('review-not-reached');
  if (evidence.historyCategory) categories.add(evidence.historyCategory); if (!evidence.notCompleted) categories.add('history-completed');
  if (!evidence.session) categories.add(evidence.sessionArtifact ? 'session-not-correlated' : 'session-missing'); if (!evidence.valueFree) categories.add('session-value-present');
  if (observed.finalAction) categories.add('final-action-activated');
  return { fixtureId: fixture.id, scenarioId, status: Object.values(checks).every(Boolean) && !categories.size ? 'passed' : 'failed',
    assertions: Object.fromEntries(Object.entries(checks).map(([key, passed]) => [key, passed ? 'passed' : 'failed'])),
    missingControlIds: [...missingFields, ...missingFiles].sort(), failureCategories: [...categories].sort() };
}
