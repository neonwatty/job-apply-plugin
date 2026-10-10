import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioIds, runScenario } from '../evals/workflows/scenarios.mjs';
for (const scenario of scenarioIds) {
  test(`installed workflow commands: ${scenario}`, { skip: !['darwin', 'linux'].includes(process.platform), timeout: 90000 }, async () => {
    const receipt = await runScenario(scenario);
    assert.ok(Object.values(receipt.checks).every(value => value === true));
    assert.ok(receipt.calls.length > 20);
    assert.equal(receipt.modelTranscript, null);
  });
}
