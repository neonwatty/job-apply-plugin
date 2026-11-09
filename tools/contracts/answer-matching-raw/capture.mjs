import { spawnSync } from 'node:child_process';
import { readFile, realpath, open } from 'node:fs/promises';
import { dirname, basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const schema = JSON.parse(await readFile(resolve(ROOT,
  'contracts/cli/python-answer-matching-raw.schema.json'), 'utf8'));
const fixtures = JSON.parse(await readFile(resolve(HERE, 'fixtures.json'), 'utf8'));
const ajv = new Ajv2020({ strict: true });
const validate = ajv.compile(schema);
const validateOutcome = ajv.compile({ $defs: schema.$defs, ...schema.$defs.outcome });
const PYTHONS = new Set(['python3', 'python3.12', 'python3.13', 'python3.14']);
const fail = () => { throw new Error('raw_reference_invalid'); };

function checkStdout(stdout) {
  if (typeof stdout !== 'string' || !stdout.endsWith('\n')) fail();
  if (stdout.includes('RAW_REFERENCE_SECRET_CANARY')
    || /(?:\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\)/.test(stdout)) fail();
  let value;
  try { value = JSON.parse(stdout); } catch { fail(); }
  if (!validateOutcome(value)) fail();
}

export function validateCorpus(value) {
  if (!validate(value)) fail();
  for (const [index, item] of value.cases.entries()) {
    const fixture = fixtures[index];
    for (const key of ['id', 'rawRequest', 'layer']) {
      if (item[key] !== fixture[key]) fail();
    }
    checkStdout(item.stdout);
  }
  const profiles = new Set([JSON.stringify(value.provenance)]);
  for (const alternate of value.alternateReferences ?? []) {
    const profile = JSON.stringify(alternate.provenance);
    if (profiles.has(profile)) fail();
    profiles.add(profile);
    const ids = new Set();
    for (const override of alternate.overrides) {
      if (ids.has(override.id)
        || !fixtures.some((f) => f.id === override.id && f.layer === 'interpreter')) fail();
      ids.add(override.id);
      checkStdout(override.stdout);
    }
  }
  return value;
}

export function captureCorpus(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => key !== 'python')) fail();
  const python = options.python ?? 'python3';
  if (!PYTHONS.has(python)) fail();
  const result = spawnSync(python, ['-I', resolve(HERE, 'reference.py')], {
    cwd: ROOT, input: '', encoding: 'utf8', timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0 || result.stderr !== '') fail();
  try { return validateCorpus(JSON.parse(result.stdout)); } catch { fail(); }
}

export function compareReference(actual, golden) {
  validateCorpus(actual);
  validateCorpus(golden);
  const sameProfile = (p) => JSON.stringify(p) === JSON.stringify(actual.provenance);
  const alternate = golden.alternateReferences?.find((p) => sameProfile(p.provenance));
  const profileKnown = sameProfile(golden.provenance) || Boolean(alternate);
  const overrides = new Map(alternate?.overrides.map((v) => [v.id, v.stdout]) ?? []);
  const applicationMismatches = [];
  const interpreterDifferences = [];
  const expectedProfileMismatches = [];
  for (const [index, item] of actual.cases.entries()) {
    const expected = golden.cases[index];
    if (item.stdout !== expected.stdout) {
      (item.layer === 'interpreter' ? interpreterDifferences : applicationMismatches).push(item.id);
    }
    if (profileKnown && item.stdout !== (overrides.get(item.id) ?? expected.stdout)) {
      expectedProfileMismatches.push(item.id);
    }
  }
  return { profileKnown, applicationMismatches, interpreterDifferences, expectedProfileMismatches };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (![2, 4].includes(argv.length) || argv[0] !== '--output'
      || !isAbsolute(argv[1]) || (argv.length === 4 && argv[2] !== '--python')) fail();
    const destination = resolve(argv[1]);
    const parent = await realpath(dirname(destination));
    const root = await realpath(ROOT);
    const rel = relative(root, parent);
    if (!(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) fail();
    const gitEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith('GIT_')));
    const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'], {
      cwd: parent, env: gitEnv, encoding: 'utf8', timeout: 3000,
    });
    if (git.error || (git.status !== 0 && git.status !== 128)
      || (git.status === 0 && git.stdout.split(/\s+/).includes('true'))) fail();
    const corpus = captureCorpus({ python: argv[3] ?? 'python3' });
    // Use the canonical parent, not an alias into a repository. Exclusive open
    // refuses existing files, hard links and final-component symbolic links.
    const file = await open(resolve(parent, basename(destination)), 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(corpus, null, 2)}\n`); }
    finally { await file.close(); }
    process.stdout.write('{"ok":true}\n');
    return 0;
  } catch {
    process.stderr.write('raw_reference_capture_failed\n');
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
