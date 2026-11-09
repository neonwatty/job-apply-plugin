// Explicit historical acceptance only. Never called by required CI or tiers.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyLegacyMigration, snapshotFiles } from '../tests_js/legacy_store_migration_support.mjs';

const historicalCommit = '07f18ee3c8854df74746492c7a4728fcdf302ff5';
const plugin = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
if (args.some(arg => !['--capture-fixture'].includes(arg))) throw Error('usage: python-store-migration-once.mjs [--capture-fixture]');
const work = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-historical-migration-')));
const execute = promisify(execFile);
try {
  const historical = join(work, 'historical'); await mkdir(historical);
  const archive = execFileSync('git', ['archive', historicalCommit, 'scripts', '.codex-plugin/plugin.json'], { cwd: plugin });
  execFileSync('tar', ['-xf', '-', '-C', historical], { input: archive });
  const version = JSON.parse(await readFile(join(historical, '.codex-plugin/plugin.json'), 'utf8')).version;
  assert.equal(version, '1.1.0');
  const source = join(work, 'python-store');
  const generator = `import importlib.util,sys,uuid
from pathlib import Path
spec=importlib.util.spec_from_file_location('historical_store',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.utc_now=lambda:'2026-08-01T12:00:00Z'
m.uuid.uuid4=lambda:uuid.UUID('11111111-1111-4111-8111-111111111111')
s=m.Store(Path(sys.argv[2]),legacy_profile=Path(sys.argv[2]).parent/'absent-legacy.json')
s.initialize()
s.replace_profile({'name':'Synthetic Migration Applicant','skills':['TypeScript'],'preferences':{'targetTitles':['Engineer']}})
a=s.put_answer({'question':'Preferred location?','value':'Remote','state':'confirmed','scope':{}})
s.append_history({'applicationId':'legacy-application','event':'started','ats':'greenhouse','status':'active','answerKeys':[a['key']]})
s.save_session('legacy-application',{'status':'active','step':'application','ats':'greenhouse','pendingFields':[],'answerKeys':[a['key']]})
`;
  await execute(process.env.PYTHON ?? 'python3', ['-I', '-c', generator, join(historical, 'scripts/job-apply-store.py'), source], { timeout: 30_000 });
  const manifest = { schemaVersion: 1, historicalCommit, historicalVersion: version, synthetic: true };
  if (args.includes('--capture-fixture')) {
    const fixture = join(plugin, 'test/fixtures/python-store-v1.1.0');
    const files = await snapshotFiles(source);
    for (const [name, bytes] of Object.entries(files)) {
      const destination = join(fixture, 'store', name);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    await writeFile(join(fixture, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  const result = await verifyLegacyMigration(source, work, plugin);
  const profile = await execute(process.env.PYTHON ?? 'python3', [join(historical, 'scripts/job-apply-store.py'), '--root', join(work, 'store'), 'profile-get'], { timeout: 30_000 });
  assert.equal(JSON.parse(profile.stdout).name, 'Synthetic Migration Applicant');
  console.log(JSON.stringify({ ...manifest, candidateDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: plugin })).digest('hex'), candidateBaseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: plugin, encoding: 'utf8' }).trim(), result: 'pass', ...result }));
} finally { await rm(work, { recursive: true, force: true }); }
