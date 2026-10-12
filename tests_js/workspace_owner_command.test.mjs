import test from 'node:test';
import assert from 'node:assert/strict';
import { runOwnerCommand } from '../apps/companion/owner-command.mjs';

function ports(ownership = 'clone') {
  const calls = [];
  return { calls, dependencies: {
    resolveLock: async () => '/plugin/flock.node',
    ownership: async root => { calls.push(['ownership', root]); return ownership; },
    validateRoot: async root => calls.push(['validate', root]),
    activate: async options => calls.push(['activate', options.root]),
    execute: async args => { calls.push(['execute', args]); return { ok: true, result: null }; },
  } };
}

test('owner invocation validation precedes Store activation and execution', async () => {
  for (const args of [[], ['serve'], ['serve','--root','relative','--job-id','job','--host-user-event'],
    ['serve','--root','/private/store','--job-id','job'],
    ['serve','--root','/private/store','--job-id','job','--host-user-event','--unknown'],
    ['serve','--root','/private/store','--root','/other','--job-id','job','--host-user-event'],
    ['serve','--root','/private/store','--job-id','job','--host-user-event','--native-lock','/untrusted']]) {
    const p = ports();
    await assert.rejects(runOwnerCommand(args, '/plugin', p.dependencies));
    assert.deepEqual(p.calls, []);
  }
});

test('explicit owner serve activates native Store and uses only packaged lock', async () => {
  const p = ports(null);
  const result = await runOwnerCommand(['serve','--root','/private/store','--job-id','job','--host-user-event'], '/plugin', p.dependencies);
  assert.deepEqual(result, {ok:true,result:null});
  assert.deepEqual(p.calls.slice(0,3), [['validate','/private/store'],['ownership','/private/store'],['activate','/private/store']]);
  assert.deepEqual(p.calls.at(-1), ['execute',['serve','--root','/private/store','--job-id','job','--host-user-event','--native-lock','/plugin/flock.node']]);
});

test('owner clients never activate or launch a Store and reject fixtures', async () => {
  const p = ports();
  await runOwnerCommand(['context','--root','/private/store','--job-id','job'], '/plugin', p.dependencies);
  assert.equal(p.calls.some(([kind])=>kind==='activate'), false);
  for (const owner of ['fixture', null]) {
    const rejected = ports(owner);
    await assert.rejects(runOwnerCommand(['context','--root','/private/store','--job-id','job'], '/plugin', rejected.dependencies));
    assert.equal(rejected.calls.some(([kind])=>kind==='activate'||kind==='execute'), false);
  }
  const fixture=ports('fixture');
  await assert.rejects(runOwnerCommand(['serve','--root','/private/store','--job-id','job','--host-user-event'], '/plugin', fixture.dependencies));
  assert.equal(fixture.calls.some(([kind])=>kind==='activate'||kind==='execute'), false);
});
