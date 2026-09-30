import { readFileSync } from 'node:fs';
import { makeLiveFormManifest, makeLiveReadinessObservation, recomputeClaimReadiness } from '../../runtime/contracts/workspace/claim-session-readiness.js';
import { fromJSON, serialize } from '../../runtime/contracts/workspace/values.js';

const roles = new Set(['textbox','combobox','radiogroup','checkbox','file']);
const states = new Set(['complete','accepted','missing','rejected','unresolved','inaccessible']);
const platforms = new Set(['ashby','greenhouse','lever','linkedin-easy-apply','rippling','workday']);
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const fail = () => { throw Error('invalid value-free form observation'); };
const plain = value => JSON.parse(serialize(value));

export function buildReadinessPacket(input) {
  if (!keys(input,['attemptRevision','platformFamily','observationRevision','complete','inventories',
    'verifiedStates','adapterState','uploadCapability','validationErrorControlIds','finalControlState'])
    || !Number.isSafeInteger(input.attemptRevision) || input.attemptRevision < 1
    || !Number.isSafeInteger(input.observationRevision) || input.observationRevision < 1
    || !platforms.has(input.platformFamily) || input.complete !== true
    || !Array.isArray(input.inventories) || !input.inventories.length || input.inventories.length > 32
    || !Array.isArray(input.verifiedStates) || !Array.isArray(input.validationErrorControlIds)
    || !['accessible','inaccessible'].includes(input.adapterState)
    || !['available','external-runtime-unavailable','not-required'].includes(input.uploadCapability)
    || !['available','unavailable','inaccessible','activated'].includes(input.finalControlState)) fail();
  const controls = new Map();
  for (const inventory of input.inventories) {
    if (!keys(inventory,['controls']) || !Array.isArray(inventory.controls) || !inventory.controls.length) fail();
    const current = new Set();
    for (const control of inventory.controls) {
      if (!keys(control,['id','role','required']) || typeof control.id !== 'string'
        || !/^[a-z][a-z0-9._-]{0,127}$/.test(control.id) || !roles.has(control.role)
        || typeof control.required !== 'boolean' || current.has(control.id)) fail();
      current.add(control.id);
      const previous = controls.get(control.id);
      if (previous && (previous.role !== control.role || previous.required !== control.required)) fail();
      controls.set(control.id,control);
    }
  }
  if (!controls.size || controls.size > 256) fail();
  const controlStates = {};
  for (const item of input.verifiedStates) {
    if (!keys(item,['id','state']) || !controls.has(item.id) || !states.has(item.state)
      || Object.hasOwn(controlStates,item.id)
      || (item.state === 'accepted' && controls.get(item.id).role !== 'file')
      || (item.state === 'complete' && controls.get(item.id).role === 'file')) fail();
    controlStates[item.id] = item.state;
  }
  if (new Set(input.validationErrorControlIds).size !== input.validationErrorControlIds.length
    || input.validationErrorControlIds.some(id => typeof id !== 'string' || !controls.has(id))) fail();
  const observedForm = {schemaVersion:1,platformFamily:input.platformFamily,
    observationRevision:input.observationRevision,complete:true,
    controls:[...controls.values()].sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0)};
  const form = fromJSON(observedForm), revision = fromJSON(input.observationRevision);
  const readinessInput = {attemptRevision:input.attemptRevision,evidenceKind:'agent_attested_current_attempt',
    observedForm,formManifest:plain(makeLiveFormManifest(form,revision,fromJSON(input.platformFamily))),
    observation:plain(makeLiveReadinessObservation(form,controlStates,revision,{
      adapterState:input.adapterState,uploadCapability:input.uploadCapability,
      validationErrorControlIds:input.validationErrorControlIds,finalControlState:input.finalControlState,
    })),expectedObservationRevision:input.observationRevision};
  const readiness = plain(recomputeClaimReadiness(fromJSON(readinessInput),fromJSON(input.attemptRevision),
    fromJSON(input.platformFamily)));
  return {readinessInput,readiness};
}

if (process.argv[1]?.endsWith('/readiness-packet.mjs')) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--input' || process.argv[3] === '-') fail();
    const source = readFileSync(process.argv[3]);
    if (source.length > 256 * 1024) fail();
    const packet = buildReadinessPacket(JSON.parse(source.toString('utf8')));
    process.stdout.write(`${JSON.stringify({ok:true,...packet})}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ok:false,error:'invalid value-free form observation'})}\n`);
    process.exitCode = 2;
  }
}
