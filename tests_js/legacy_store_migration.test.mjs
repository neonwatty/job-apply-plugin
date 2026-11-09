import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLegacyMigration } from './legacy_store_migration_support.mjs';

test('TypeScript migrates the captured historical Python Store and preserves rollback bytes', async t => {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'legacy-store-regression-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const plugin = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  t.diagnostic(JSON.stringify(await verifyLegacyMigration(join(plugin, 'test/fixtures/python-store-v1.1.0/store'), work, plugin)));
});
