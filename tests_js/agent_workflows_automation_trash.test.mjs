import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const path = '.workflows/workflows/job-apply.synthetic-automation-trash.workflow.yaml';
const source = readFileSync(path, 'utf8');
const overrideIndex = source.indexOf('\nplatformOverrides:');
const stepsIndex = source.indexOf('\nsteps:', overrideIndex);
const desktopSource = source.slice(0, overrideIndex);
const mobileOverride = source.slice(overrideIndex, stepsIndex);

test('automation Trash workflow resolves distinct desktop and mobile product Stores', () => {
  assert.match(desktopSource, /job-apply-store-desktop/);
  assert.doesNotMatch(desktopSource, /job-apply-store-mobile/);
  assert.match(mobileOverride, /job-apply-store-mobile/);
  assert.doesNotMatch(mobileOverride, /job-apply-store-desktop/);
  assert.match(mobileOverride, /rollback sidecars are bound to their active Store basename/);
});

test('automation Trash mobile workflow resolves the required 393 by 852 viewport', () => {
  const match = source.match(/- id: mobile-web[\s\S]*?viewport:\s*\n\s+width: (\d+)\s*\n\s+height: (\d+)/);
  assert.ok(match, 'mobile-web viewport must be declared');
  const viewport = { width: Number(match[1]), height: Number(match[2]) };

  assert.deepEqual(viewport, { width: 393, height: 852 });
  assert.match(mobileOverride, /393 by 852/);
  assert.doesNotMatch(mobileOverride, /390 by 844|390 pixels/);
});
