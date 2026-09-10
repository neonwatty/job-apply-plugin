import assert from 'node:assert/strict';
import { cp, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { parse } from '../runtime/contracts/workspace/values.js';
import { canonicalJson } from '../runtime/contracts/workspace/canonical-json.js';
import { plain, snapshot } from './workspace_native_claims_support.mjs';
export const fixed = '2026-09-10T14:00:00Z';
export const item = (name, extra = {}) => ({url:`https://example.invalid/${name}`, ...extra});
export const batch = (...jobs) => ({jobs});
export async function differential(service, root, referenceRoot, operations) {
  await cp(root, referenceRoot, {recursive:true, preserveTimestamps:true});
  const reference = JSON.parse((await promisify(execFile)('python3', [
    'tools/contracts/job-upsert/reference.py', referenceRoot, JSON.stringify(operations),
  ], {maxBuffer:8 * 1024 * 1024})).stdout);
  for (const [index, operation] of operations.entries()) {
    const input = parse(operation.payloadJson ?? JSON.stringify(operation.payload));
    const origin = operation.origin ?? 'human';
    let result;
    const before = await snapshot(root);
    try {
      const preview = plain(await service.preview(input, origin));
      assert.deepEqual(await snapshot(root), before, 'preview must preserve canonical bytes');
      result = {preview};
      try {
        result.commit = plain(await service.commit(operation.commitPayload ? parse(JSON.stringify(operation.commitPayload)) : input,
          operation.commitOrigin ?? origin, operation.token ?? preview.token));
      } catch (error) { result.error = error.message; }
    } catch (error) { result = {error:error.message}; }
    const {document, ...expected} = reference[index];
    assert.deepEqual(result, expected, `operation ${index}: ${JSON.stringify(operation)}`);
    assert.equal(canonicalJson(parse(await readFile(join(root,'jobs.json'),'utf8'))), canonicalJson(parse(document)), `durable operation ${index}`);
    const after = await snapshot(root);
    if (!result.commit?.committed) assert.deepEqual(after,before,'rejected/noop commit must preserve bytes');
    delete before['jobs.json']; delete after['jobs.json'];
    assert.deepEqual(after,before,'upsert may only change jobs.json');
  }
}
export async function unchanged(root, operation, pattern) {
  const before = await snapshot(root);
  await assert.rejects(operation,pattern);
  assert.deepEqual(await snapshot(root),before);
}
