import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { nativeJobsCommandFamilies, nativeJobsCommandFields } from '../runtime/cli/native-jobs.js';

test('every Python Store command has exactly one native owner', async () => {
  const parser = await readFile('scripts/job_apply_store/cli_parser.py', 'utf8');
  const python = [...parser.matchAll(/commands\.add_parser\(["']([^"']+)/g)].map(match => match[1]);
  assert.equal(python.length, 99, 'Python command inventory changed; update the native ownership registry');
  assert.equal(new Set(python).size, python.length, 'Python parser contains duplicate command names');

  const owned = nativeJobsCommandFamilies.flatMap(family => Object.keys(family.fields)
    .map(command => ({ command, owner: family.owner })));
  const counts = new Map();
  for (const item of owned) counts.set(item.command, [...counts.get(item.command) ?? [], item.owner]);
  assert.deepEqual([...counts].filter(([, owners]) => owners.length !== 1), []);
  assert.deepEqual(python.filter(command => !Object.hasOwn(nativeJobsCommandFields, command)), []);
});
