import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory=dirname(fileURLToPath(import.meta.url));
const fixture=JSON.parse(await readFile(join(directory,'fixture.json'),'utf8'));
const args=new Map();
for(let index=2;index<process.argv.length;index+=2){const key=process.argv[index],value=process.argv[index+1];
  if(!key?.startsWith('--')||!value||args.has(key))throw Error('invalid synthetic portal invocation');args.set(key,value);}
const command=args.get('--command'),requested=args.get('--journey-root');
if(!command||!requested||requested!==resolve(requested))throw Error('an absolute journey root is required');
const root=await realpath(requested),statePath=join(root,'portal-state.json');
if(root!==requested||fixture.syntheticOnly!==true)throw Error('synthetic portal is unavailable');
const state=JSON.parse(await readFile(statePath,'utf8'));
if(state.fixtureId!==fixture.fixtureId||state.syntheticOnly!==true)throw Error('synthetic portal identity is invalid');

if(command==='inspect'){
  process.stdout.write(`${JSON.stringify({fixtureId:state.fixtureId,destinationUrl:state.destinationUrl,stage:state.stage,
    controls:state.requiredOperations.map(operation=>({operation,state:state.completedOperations.includes(operation)?'complete':'empty'})),
    finalAction:{label:state.finalActionLabel,activated:state.finalActionActivated}})}\n`);
}else if(command==='apply'){
  const operation=args.get('--operation'),decisionPath=args.get('--decision');
  if(state.stage!=='form'||!operation||!decisionPath||decisionPath!==resolve(decisionPath))throw Error('synthetic application action is unavailable');
  const envelope=JSON.parse(await readFile(decisionPath,'utf8'));
  const decision=envelope.ok===true&&envelope.event==='authority_evaluated'?envelope.decision:envelope;
  const expected=state.requiredOperations[state.completedOperations.length];
  if(decision.authorized!==true||decision.mode!=='campaign_to_review'||!decision.operations?.includes(operation)
    ||operation!==expected)throw Error('synthetic application action is not authorized');
  state.completedOperations.push(operation);state.audit.push({kind:'authorized-operation',operation});
  if(state.completedOperations.length===state.requiredOperations.length)state.stage='final_review';
  await writeFile(statePath,`${JSON.stringify(state)}\n`,{mode:0o600});
  process.stdout.write(`${JSON.stringify({ok:true,operation,stage:state.stage})}\n`);
}else if(command==='submit'){
  state.finalActionActivated=true;state.audit.push({kind:'final-action',label:state.finalActionLabel});
  await writeFile(statePath,`${JSON.stringify(state)}\n`,{mode:0o600});
  process.stdout.write(`${JSON.stringify({ok:false,reasonCode:'synthetic_final_action_activated'})}\n`);
  process.exitCode=2;
}else throw Error('unknown synthetic portal command');
