import assert from 'node:assert/strict';
import { open, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { withExclusiveFileLock } from '../runtime/store/exclusive-file-lock.js';
import { child, lockModule, nativeFixture, providerModule } from './exclusive_file_lock_support.mjs';

const prelude = `import {loadPosixFlockProvider} from ${JSON.stringify(providerModule)};
import {withExclusiveFileLock} from ${JSON.stringify(lockModule)};
const provider=loadPosixFlockProvider(process.argv[1]);
const options={provider,pathProfile:'3.14',retryMilliseconds:2};
const report=value=>process.stdout.write(value+'\\n');`;

test('eight independent TypeScript writers serialize through the actual native lock', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('Native POSIX host required'); return; }
  const fixture = await nativeFixture();
  const children = [];
  try {
    const lock = join(fixture.root, 'synthetic.lock');
    const counter = join(fixture.root, 'counter');
    await writeFile(counter, '0');
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let ready;
    const acquired = new Promise(resolve => { ready = resolve; });
    const held = withExclusiveFileLock(lock, async () => { ready(); await gate; }, { provider, pathProfile: '3.14' });
    await acquired;
    try {
      for (let index = 0; index < 8; index += 1) {
        const worker = child(prelude + `
import {readFile,writeFile} from 'node:fs/promises';
let waited=false;
options.provider={tryLock(fd){const acquired=provider.tryLock(fd);
 if(!acquired&&!waited){report('contended');waited=true;}return acquired;},unlock:fd=>provider.unlock(fd)};
report('ready');
await withExclusiveFileLock(process.argv[2],async()=>{
 report('acquired');
 const count=Number(await readFile(process.argv[3],'utf8'));
 await new Promise(resolve=>setTimeout(resolve,10));
 await writeFile(process.argv[3],String(count+1));
},options);report('done');`, [fixture.receipt.artifact, lock, counter]);
        children.push(worker);
      }
      await Promise.all(children.map(worker => worker.line('ready')));
      await Promise.all(children.map(worker => worker.line('contended')));
      assert.equal(await readFile(counter, 'utf8'), '0');
      assert.ok(children.every(worker => !worker.lines.includes('acquired')));
    } finally { release(); await held; }
    await Promise.all(children.map(worker => worker.line('done')));
    await Promise.all(children.map(worker => worker.success()));
    assert.equal(await readFile(counter, 'utf8'), '8');
  } finally { await Promise.all(children.map(worker => worker.stop())); await fixture.cleanup(); }
});

test('kernel releases ownership on holder process death and aliases contend', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('Native POSIX host required'); return; }
  const fixture = await nativeFixture();
  const children = [];
  try {
    const lock = join(fixture.root, 'synthetic.lock');
    await writeFile(lock, '');
    const alias = join(fixture.root, 'alias.lock');
    await symlink('synthetic.lock', alias);
    const holder = child(prelude + `const keeper=setInterval(()=>{},1000);
try{await withExclusiveFileLock(process.argv[2],async()=>{
report('held');await new Promise(()=>{});},options);}finally{clearInterval(keeper);}`, [fixture.receipt.artifact, lock]);
    children.push(holder);
    await holder.line('held');
    const aliasHandle = await open(alias, 'r+');
    try {
      const provider = loadPosixFlockProvider(fixture.receipt.artifact);
      assert.equal(provider.tryLock(aliasHandle.fd), false, 'Alias must contend while the holder is alive');
    } finally { await aliasHandle.close(); }
    const waiter = child(prelude + `report('ready');await withExclusiveFileLock(process.argv[2],async()=>report('acquired'),options);report('done');`,
      [fixture.receipt.artifact, alias]);
    children.push(waiter);
    await waiter.line('ready');
    assert.ok(!waiter.lines.includes('acquired'));
    holder.process.kill('SIGKILL');
    await holder.exited;
    await waiter.line('done'); await waiter.success();
  } finally { await Promise.all(children.map(worker => worker.stop())); await fixture.cleanup(); }
});

test('cancellation stops a waiter but never releases a still-running callback', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('Native POSIX host required'); return; }
  const fixture = await nativeFixture();
  try {
    const path = join(fixture.root, 'synthetic.lock');
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    const options = { provider, pathProfile: '3.14', retryMilliseconds: 1 };
    let release; let ready;
    const gate = new Promise(resolve => { release = resolve; });
    const acquired = new Promise(resolve => { ready = resolve; });
    const ownerSignal = new AbortController();
    const held = withExclusiveFileLock(path, async signal => { ready(); await gate; assert.equal(signal.aborted, true); },
      { ...options, signal: ownerSignal.signal });
    await acquired;
    try {
      const waiting = new AbortController();
      let invoked = false;
      const result = withExclusiveFileLock(path, async () => { invoked = true; }, { ...options, signal: waiting.signal });
      waiting.abort();
      await assert.rejects(result, error => error.name === 'AbortError');
      assert.equal(invoked, false);
      ownerSignal.abort();
      const probe = await open(path, 'r+');
      try { assert.equal(provider.tryLock(probe.fd), false, 'Held abort must retain the actual kernel lock'); }
      finally { await probe.close(); }
      const second = new AbortController();
      const blocked = withExclusiveFileLock(path, async () => { invoked = true; }, { ...options, signal: second.signal });
      second.abort();
      await assert.rejects(blocked, error => error.name === 'AbortError');
      assert.equal(invoked, false);
    } finally { release(); await held; }
    assert.equal(await withExclusiveFileLock(path, async () => 'released', options), 'released');
  } finally { await fixture.cleanup(); }
});
