import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, snapshot, readyPacket } from './workspace_native_claims_support.mjs';
import { applicationContext } from '../runtime/workflows/applications/context.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';

test('workflow context follows canonical acquire, handoff, restart and revision changes', {timeout:60000}, async()=>{
  const fixture=await nativeFixture();
  try {
    const state=await setup(fixture,'context-lifecycle'), access={token:null,ownerLabel:text('Synthetic owner')};
    const inspect=async candidates=>{
      const before=await snapshot(state.root);
      const result=await state.repository.claimTransaction(tx=>applicationContext(tx,'job',candidates,access,()=>state.clock.now));
      assert.deepEqual(await snapshot(state.root),before,'inspection does not write to the fixture Store');
      assert.doesNotMatch(JSON.stringify(result),/PRIVATE|claim_|tokenHash|readinessInput/);
      return result;
    };
    const selection={kind:'select',expectedRevision:1n,ownerConfirmed:true};
    assert.equal((await inspect([selection])).allowedActions.length,1);
    await state.claims.select('job',1n,true);
    assert.equal((await inspect([selection])).allowedActions.length,0);
    const acquire={kind:'acquire',expectedRevision:2n};
    assert.equal((await inspect([acquire])).allowedActions.length,1);
    access.token=text(plain(await state.claims.acquire('job',access.ownerLabel,2n)).token);
    const review=fromJSON({status:'review',readinessInput:readyPacket(3)});
    const handoff={kind:'handoff',expectedRevision:3n,target:'awaiting_review',incoming:review};
    const held=await inspect([handoff]);
    assert.equal(held.canLeave,false);
    assert.equal(held.allowedActions.length,1);
    await state.claims.handoff('job',access.token,'awaiting_review',review,3n);
    const restart={kind:'restart',expectedRevision:4n,ownerConfirmedNotSubmitted:true};
    const released=await inspect([restart]);
    assert.equal(released.status,'awaiting_review');
    assert.equal(released.canLeave,true);
    assert.equal(released.allowedActions.length,1);
    assert.equal((await inspect([{...restart,ownerConfirmedNotSubmitted:false}])).allowedActions.length,0);
    const started=plain(await state.claims.restart('job',access.ownerLabel,4n,true));
    assert.equal(started.job.revision,5);
    assert.equal((await inspect([handoff])).allowedActions.length,0,'old bearer and attempt cannot be reused');
    access.token=text(started.token);
    const paused=fromJSON({status:'active',blockers:[{type:'browser_handoff',code:'unsupported-control'}]});
    const pause={kind:'handoff',expectedRevision:5n,target:'needs_info',incoming:paused};
    assert.equal((await inspect([pause])).allowedActions.length,1);
    await state.claims.handoff('job',access.token,'needs_info',paused,5n);
    const final=await inspect([]);
    assert.equal(final.status,'needs_info');
    assert.equal(final.canLeave,true);
    assert.equal(final.jobRevision,'6');
  } finally { await fixture.cleanup(); }
});
