import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { withExclusiveFileLock } from '../runtime/store/exclusive-file-lock.js';
import { child, lockModule, nativeFixture, providerModule } from './exclusive_file_lock_support.mjs';

const historyModule = new URL('../runtime/store/jsonl-history.js', import.meta.url).href;
const ioModule = new URL('../runtime/store/jsonl-history-io.js', import.meta.url).href;
const prelude = `import {loadPosixFlockProvider} from ${JSON.stringify(providerModule)};
import {withExclusiveFileLock} from ${JSON.stringify(lockModule)};
import {appendHistoryEvent,repairPendingHistoryTail} from ${JSON.stringify(historyModule)};
import {readFile} from 'node:fs/promises';
const provider=loadPosixFlockProvider(process.argv[1]);
const options={provider,pathProfile:'3.14',retryMilliseconds:2};
const serialization={pathProfile:'3.14',intMaxStrDigits:4300};
const report=value=>process.stdout.write(value+'\\n');
const history=process.argv[3];
// Synthetic identity predicate: this does not implement domain collision policy.
const isIdempotent=async event=>(await readFile(history,'utf8')).trim().split('\\n')
 .filter(Boolean).map(line=>JSON.parse(line)).some(row=>row.eventId===event.get('eventId'));
let waited=false;
options.provider={tryLock(fd){const acquired=provider.tryLock(fd);
 if(!acquired&&!waited){report('contended');waited=true;}return acquired;},unlock:fd=>provider.unlock(fd)};`;

test('eight contending writers append complete unique lines with a synthetic retry predicate', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('Native POSIX host required'); return; }
  const fixture = await nativeFixture();
  const children = [];
  try {
    const lock = join(fixture.root, 'history.lock');
    const history = join(fixture.root, 'history.jsonl');
    await writeFile(history, '');
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    let release; let ready;
    const gate = new Promise(resolve => { release = resolve; });
    const acquired = new Promise(resolve => { ready = resolve; });
    const held = withExclusiveFileLock(lock, async () => { ready(); await gate; }, { provider, pathProfile: '3.14' });
    await acquired;
    try {
      for (let index = 0; index < 8; index += 1) {
        children.push(child(prelude + `
await withExclusiveFileLock(process.argv[2],async()=>{
 const event=new Map([['eventId',process.argv[4]],['text','λ 😀']]);
 await appendHistoryEvent(history,event,{isIdempotent,serialization});
 await appendHistoryEvent(history,event,{isIdempotent,serialization});
},options);report('done');`, [fixture.receipt.artifact, lock, history, String(index)]));
      }
      await Promise.all(children.map(worker => worker.line('contended')));
      assert.equal(await readFile(history, 'utf8'), '');
      assert.ok(children.every(worker => !worker.lines.includes('done')));
    } finally { release(); await held; }
    await Promise.all(children.map(worker => worker.line('done')));
    await Promise.all(children.map(worker => worker.success()));
    const lines = (await readFile(history, 'utf8')).split('\n');
    assert.equal(lines.pop(), '', 'Every acknowledged line must end with a newline');
    assert.deepEqual(lines.sort(), Array.from({ length: 8 }, (_, index) =>
      `{"eventId": "${index}", "text": "λ 😀"}`));
  } finally { await Promise.all(children.map(worker => worker.stop())); await fixture.cleanup(); }
});

for (const boundary of ['partial', 'complete']) {
  test(`killed ${boundary} append owner releases lock for repeatable pending-tail repair`, async (t) => {
    if (!['darwin', 'linux'].includes(process.platform)) { t.skip('Native POSIX host required'); return; }
    const fixture = await nativeFixture();
    const children = [];
    try {
      const lock = join(fixture.root, 'history.lock');
      const history = join(fixture.root, 'history.jsonl');
      const original = '{"eventId": "old"}\n';
      const next = '{"eventId": "recovered", "text": "λ 😀"}\n';
      await writeFile(history, original);
      const holder = child(prelude + `
import {createNativeJsonlHistoryIO} from ${JSON.stringify(ioModule)};
const native=createNativeJsonlHistoryIO('3.14');
const io={...native,async open(...args){const handle=await native.open(...args);
 return {...handle,async write(bytes){
  const count=await handle.write(process.argv[4]==='partial'?bytes.subarray(0,7):bytes);
  report('bytes-written');
  // Keep the suspended write reachable so FileHandle GC cannot release the lock.
  await new Promise(resolve=>{globalThis.retainInterruptedWrite=resolve;});
  return count;
 }};}};
const keeper=setInterval(()=>{},1000);
try{await withExclusiveFileLock(process.argv[2],async()=>{
 await appendHistoryEvent(history,new Map([['eventId','recovered'],['text','λ 😀']]),
  {isIdempotent,serialization,io});
},options);}finally{clearInterval(keeper);}`, [fixture.receipt.artifact, lock, history, boundary]);
      children.push(holder);
      await holder.line('bytes-written');
      const observed = await readFile(history);
      assert.deepEqual(observed, Buffer.concat([Buffer.from(original),
        boundary === 'partial' ? Buffer.from(next).subarray(0, 7) : Buffer.from(next)]));
      const waiter = child(prelude + `
await withExclusiveFileLock(process.argv[2],async()=>{
 const repair={pendingOperation:async()=>({synthetic:true}),pathProfile:'3.14'};
 await repairPendingHistoryTail(history,repair);
 const repaired=await readFile(history);
 await repairPendingHistoryTail(history,repair);
 if(!repaired.equals(await readFile(history)))throw new Error('Repeated repair changed bytes');
 await appendHistoryEvent(history,new Map([['eventId','recovered'],['text','λ 😀']]),
  {isIdempotent,serialization});
},options);report('done');`, [fixture.receipt.artifact, lock, history]);
      children.push(waiter);
      await waiter.line('contended');
      assert.deepEqual(await readFile(history), observed, 'Contending recovery cannot mutate held history');
      holder.process.kill('SIGKILL');
      assert.equal((await holder.exited).signal, 'SIGKILL');
      await waiter.line('done');
      await waiter.success();
      assert.equal(await readFile(history, 'utf8'), original + next);
    } finally { await Promise.all(children.map(worker => worker.stop())); await fixture.cleanup(); }
  });
}
