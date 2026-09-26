import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { fields, matches, member, positive, requireCondition as check } from './answer-session-fields.js';
import { get, object, parse, same, set, string, integer, fromJSON, JobsError } from './values.js';
import type { Document, Value } from './values.js';

const kindByRole: Record<string, string> = { textbox:'text', combobox:'selection', radiogroup:'selection', checkbox:'toggle', file:'upload' };
const livePlatforms = ['ashby','greenhouse','lever','linkedin-easy-apply','rippling','workday'];
const digest = (value: Value): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
function controlsOf(fixture: Document): Document[] {
  const steps = get(fixture, 'steps');
  check(Array.isArray(steps), 'invalid fixture steps');
  return (steps as Value[]).flatMap(step => {
    const controls = get(object(step, 'step'), 'controls');
    check(Array.isArray(controls), 'invalid fixture controls');
    return (controls as Value[]).map(item => object(item, 'control'));
  });
}
function liveControls(form: Document, revision: Value, ats: Value): Document[] {
  check(fields(form, ['schemaVersion','platformFamily','observationRevision','complete','controls'], true), 'invalid observed form fields');
  check(positive(revision) && same(get(form,'schemaVersion'),integer(1n)) && same(get(form,'observationRevision'),revision)
    && get(form,'complete') === true, 'invalid observed form attestation');
  const platform = string(get(form,'platformFamily'));
  check(platform !== null && livePlatforms.includes(platform) && (!string(ats) || platform === string(ats)), 'observed form ATS mismatch');
  const raw = get(form,'controls');
  check(Array.isArray(raw) && raw.length > 0 && raw.length <= 256, 'invalid observed form controls');
  const controls = (raw as Value[]).map(item => object(item,'observed form control'));
  let previous = '';
  for (const control of controls) {
    check(fields(control,['id','role','required'],true), 'invalid observed form control fields');
    const id = string(get(control,'id'));
    check(matches(get(control,'id'),/^[a-z][a-z0-9._-]{0,127}$/u) && id! > previous, 'invalid observed form control id');
    check(Object.hasOwn(kindByRole,string(get(control,'role')) ?? '') && typeof get(control,'required') === 'boolean', 'invalid observed form control');
    previous = id!;
  }
  check(controls.some(control => get(control,'required') === true), 'observed form has no required control');
  return controls;
}
function manifestFrom(controls: Document[], platform: Value, revision: Value, legacy: boolean): Document {
  const required = controls.filter(item => get(item,'required') === true);
  check(required.length > 0, 'form has no required control');
  const ids = required.map(item => string(get(item,'id'))!).sort();
  const fingerprint = `sha256:${digest(legacy ? fromJSON({platformFamily:string(platform),requiredControlIds:ids})
    : fromJSON({platformFamily:string(platform),controls:controls.map(control => ({id:string(get(control,'id')),
      role:string(get(control,'role')),required:get(control,'required')}))}))}`;
  const manifest = object(fromJSON({schemaVersion:1,platformFamily:string(platform),requiredControlIds:ids,controlSetFingerprint:fingerprint,complete:true}), 'manifest');
  return set(manifest,'observationRevision',revision);
}
/** Build the value-free manifest after independently reading every visible control. */
export function makeLiveFormManifest(rawForm: Value, observationRevision: Value, ats: Value = null): Document {
  const form = object(rawForm,'observed form');
  return manifestFrom(liveControls(form,observationRevision,ats),get(form,'platformFamily'),observationRevision,false);
}
/** Serialize actual observed states; this does not inspect or prove browser state. */
export function makeLiveReadinessObservation(rawForm: Value, states: Record<string,string>, observationRevision: Value,
  options: {adapterState:string;uploadCapability:string;validationErrorControlIds:string[];finalControlState:string}): Document {
  const form = object(rawForm,'observed form'), controls = liveControls(form,observationRevision,null);
  const byId = new Map(controls.map(control => [string(get(control,'id'))!,control]));
  check(states !== null && typeof states === 'object' && !Array.isArray(states), 'invalid live control states');
  const observed = Object.entries(states).sort(([a],[b])=>a.localeCompare(b)).map(([id,state]) => {
    const control = byId.get(id);
    check(control !== undefined, 'unknown live control state');
    return {controlId:id,kind:kindByRole[string(get(control!,'role'))!],state,observationRevision:1};
  });
  const observation = object(fromJSON({schemaVersion:1,platformFamily:string(get(form,'platformFamily')),observationRevision:1,
    adapterState:options.adapterState,uploadCapability:options.uploadCapability,controls:observed,
    validationErrorControlIds:[...options.validationErrorControlIds].sort(),finalControlState:options.finalControlState}), 'observation');
  set(observation,'observationRevision',observationRevision);
  for (const item of get(observation,'controls') as Value[]) set(object(item,'observed control'),'observationRevision',observationRevision);
  validateObservation(observation,get(form,'platformFamily'),controls);
  return observation;
}
function validateObservation(observation: Document, platform: Value, controls: Document[]): Document[] {
  check(fields(observation, ['schemaVersion','platformFamily','observationRevision','adapterState','uploadCapability','controls','validationErrorControlIds','finalControlState'], true), 'invalid observation fields');
  check(positive(get(observation, 'schemaVersion')) && same(get(observation, 'schemaVersion'), integer(1n)), 'invalid observation version');
  check(same(get(observation, 'platformFamily'), platform) && positive(get(observation, 'observationRevision')), 'invalid observation identity');
  check(member(get(observation, 'adapterState'), ['accessible','inaccessible']), 'invalid adapter state');
  check(member(get(observation, 'uploadCapability'), ['available','external-runtime-unavailable','not-required']), 'invalid upload capability');
  check(member(get(observation, 'finalControlState'), ['available','unavailable','inaccessible','activated']), 'invalid final state');
  const raw = get(observation, 'controls');
  check(Array.isArray(raw), 'invalid controls');
  const observed = (raw as Value[]).map(item => object(item, 'observed control'));
  const known = new Map(controls.map(item => [string(get(item,'id'))!, item]));
  const seen = new Set<string>();
  for (const item of observed) {
    check(fields(item, ['controlId','kind','state','observationRevision'], true), 'invalid observed control fields');
    const id = string(get(item, 'controlId'));
    check(id !== null && known.has(id) && !seen.has(id), 'invalid observed identity');
    seen.add(id!);
    const kind = kindByRole[string(get(known.get(id!)!, 'role'))!];
    check(kind !== undefined && string(get(item,'kind')) === kind, 'invalid control kind');
    check(member(get(item,'state'), [kind === 'upload' ? 'accepted':'complete','missing','rejected','unresolved','inaccessible']), 'invalid control state');
    check(positive(get(item,'observationRevision')), 'invalid control revision');
  }
  const errors = get(observation, 'validationErrorControlIds');
  check(Array.isArray(errors), 'invalid validation errors');
  const ids = (errors as Value[]).map(string);
  check(ids.every(id => id !== null && known.has(id)) && new Set(ids).size === ids.length, 'invalid validation identities');
  check(ids.every((id,index) => index === 0 || ids[index-1]! < id!), 'unsorted validation identities');
  return observed;
}

/** Recompute from a closed current-form attestation or a bundled replay fixture. */
export function recomputeClaimReadiness(raw: Value, attempt: Value, ats: Value): Document {
  let packet: Document;
  try { packet = object(raw, 'readiness input'); }
  catch { throw new JobsError('readiness input must be a JSON object'); }
  const legacy = get(packet,'fixture') !== null;
  check(fields(packet, ['attemptRevision','evidenceKind',legacy ? 'fixture':'observedForm','observation','expectedObservationRevision','formManifest'], true), 'readiness input contains unsupported fields');
  check(same(get(packet,'attemptRevision'), attempt), 'readiness input is not bound to the current attempt');
  check(member(get(packet,'evidenceKind'), ['agent_attested_current_attempt','repository_replay']), 'readiness evidence kind is unsupported');
  try {
    const revision = get(packet, 'expectedObservationRevision');
    check(positive(revision), 'invalid expected revision');
    let controls: Document[], platform: Value;
    if (legacy) {
      const fixture = object(get(packet,'fixture'), 'readiness fixture');
      check(matches(get(fixture,'id'), /^[a-z0-9][a-z0-9-]{0,127}$/u), 'invalid fixture id');
      const trusted = parse(readFileSync(new URL(`../../../qa/fixtures/${string(get(fixture,'id'))}/fixture.json`, import.meta.url), 'utf8'));
      check(canonicalJson(fixture) === canonicalJson(trusted), 'fixture differs from bundled definition');
      check(!string(ats) || same(get(fixture,'platformFamily'), ats), 'fixture ATS mismatch');
      controls = controlsOf(fixture);
      platform = get(fixture,'platformFamily');
    } else {
      check(string(get(packet,'evidenceKind')) === 'agent_attested_current_attempt', 'live form requires current attempt attestation');
      const form = object(get(packet,'observedForm'),'observed form');
      controls = liveControls(form,revision,ats);
      platform = get(form,'platformFamily');
    }
    const required = controls.filter(item => get(item,'required') === true);
    const manifest = manifestFrom(controls,platform,revision,legacy);
    const fingerprint = string(get(manifest,'controlSetFingerprint'))!;
    const ids = (get(manifest,'requiredControlIds') as Value[]).map(item=>string(item)!);
    check(same(get(packet,'formManifest'),manifest), 'form manifest mismatch');
    const observation = object(get(packet,'observation'), 'observation');
    const observed = validateObservation(observation,platform,controls);
    const byId = new Map(observed.map(item => [string(get(item,'controlId'))!,item]));
    const missing = required.filter(item => !byId.has(string(get(item,'id'))!));
    const present = required.flatMap(item => {
      const value = byId.get(string(get(item,'id'))!);
      return value ? [value] : [];
    });
    const stale = present.filter(item => !same(get(item,'observationRevision'),revision));
    const incomplete = present.filter(item => string(get(item,'state')) !== (string(get(item,'kind')) === 'upload' ? 'accepted':'complete'));
    const requiredUploads = new Set(required.filter(item => string(get(item,'role')) === 'file').map(item => string(get(item,'id'))));
    const missingUpload = missing.some(item => requiredUploads.has(string(get(item,'id')))) || incomplete.some(item => string(get(item,'kind')) === 'upload' && string(get(item,'state')) === 'missing');
    const assertions: Record<string, boolean> = {
      'observation-current':same(get(observation,'observationRevision'),revision) && stale.length === 0,
      'adapter-accessible':string(get(observation,'adapterState')) === 'accessible',
      'required-controls-complete':missing.length + stale.length + incomplete.length === 0,
      'required-uploads-accepted': !missing.some(item => requiredUploads.has(string(get(item,'id')))) && ![...stale,...incomplete].some(item => requiredUploads.has(string(get(item,'controlId')))),
      'validation-clear':(get(observation,'validationErrorControlIds') as Value[]).length === 0,
      'final-control-available':string(get(observation,'finalControlState')) === 'available',
      'final-action-untouched':string(get(observation,'finalControlState')) !== 'activated',
    };
    const blockers = new Set<string>();
    if (!assertions['observation-current']) blockers.add('readiness-evidence-stale');
    if (!assertions['adapter-accessible']) blockers.add('form-observation-inaccessible');
    if (missing.length) blockers.add('required-control-evidence-missing');
    if (missingUpload) blockers.add('required-upload-missing');
    for (const item of incomplete) {
      const state = string(get(item,'state')), upload = string(get(item,'kind')) === 'upload';
      if (state === 'rejected') blockers.add(upload ? 'required-upload-rejected':'required-control-rejected');
      else if (state === 'unresolved') blockers.add('required-control-unresolved');
      else if (state === 'inaccessible') blockers.add('required-control-inaccessible');
      else if (state === 'missing' && !upload) blockers.add('required-control-incomplete');
    }
    if (!assertions['validation-clear']) blockers.add('validation-error-present');
    const final = string(get(observation,'finalControlState'));
    if (final === 'activated') blockers.add('final-action-activated');
    else if (final === 'inaccessible') blockers.add('final-control-inaccessible');
    else if (final === 'unavailable') blockers.add('final-control-unavailable');
    const fallback = missingUpload && string(get(observation,'uploadCapability')) === 'external-runtime-unavailable' ? 'owner-upload-required':null;
    if (fallback) blockers.add('external-upload-capability-unavailable');
    const result = object(fromJSON({status:Object.values(assertions).every(Boolean) ? 'ready':'blocked',
      assertions:Object.fromEntries(Object.entries(assertions).map(([key,passed]) => [key,passed ? 'passed':'failed'])),
      blockerCodes:[...blockers].sort(), fallbackCode:fallback, controlSetFingerprint:fingerprint, requiredControlCount:ids.length}), 'readiness');
    set(result,'attemptRevision',attempt);
    set(result,'observationRevision',get(observation,'observationRevision'));
    return set(result,'evidenceKind',get(packet,'evidenceKind'));
  } catch { throw new JobsError('readiness evidence is invalid'); }
}
