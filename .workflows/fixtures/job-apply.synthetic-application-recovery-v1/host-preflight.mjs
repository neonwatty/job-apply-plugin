import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(fixtureDirectory, '../../..');

function contained(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export function applicationRecoveryLayout(journeyRoot) {
  if (!isAbsolute(journeyRoot) || journeyRoot !== resolve(journeyRoot)) {
    throw new Error('The application-recovery journey root must be absolute');
  }
  const runnerStoreRoot = join(journeyRoot, 'runner-store');
  const productStoreRoot = join(journeyRoot, 'product-store');
  const productRollbackRoot = `${productStoreRoot}.python-rollback`;
  const legacyProfilePath = join(journeyRoot, 'no-legacy-profile.json');
  const paths = [runnerStoreRoot, productStoreRoot, productRollbackRoot];
  for (let left = 0; left < paths.length; left++) {
    for (let right = left + 1; right < paths.length; right++) {
      if (contained(paths[left], paths[right]) || contained(paths[right], paths[left])) {
        throw new Error('Runner, product, and rollback roots must be separate');
      }
    }
  }
  return { journeyRoot, runnerStoreRoot, productStoreRoot, productRollbackRoot, legacyProfilePath };
}

async function absent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} must be absent for a fresh application-recovery attempt`);
}

export async function applicationRecoveryHostPreflight({
  journeyRoot,
  repositoryRoot = defaultRepositoryRoot,
} = {}) {
  const layout = applicationRecoveryLayout(journeyRoot);
  await absent(layout.journeyRoot, 'Journey root');
  const fixtureControlPath = join(
    repositoryRoot,
    '.workflows/fixtures/job-apply.synthetic-application-recovery-v1/fixture-control.mjs',
  );
  let capability;
  try {
    capability = await lstat(fixtureControlPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!capability?.isFile() || capability.isSymbolicLink()) {
    throw new Error(
      'job-apply.fixture-control is not committed; do not create Stores, start Companion, or run workflow train',
    );
  }
  return { ...layout, fixtureControlPath };
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--journey-root', '--repository-root'].includes(key) || !value || values.has(key)) {
      throw new Error('Usage: node host-preflight.mjs --journey-root /absolute/fresh/root');
    }
    values.set(key, value);
  }
  const journeyRoot = values.get('--journey-root');
  if (!journeyRoot) throw new Error('Missing --journey-root');
  return {
    journeyRoot,
    ...(values.has('--repository-root') ? { repositoryRoot: resolve(values.get('--repository-root')) } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify({
      schema: 'job-apply-application-recovery-host-preflight/v1',
      ready: true,
      ...await applicationRecoveryHostPreflight(parseArgs(process.argv.slice(2))),
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Application-recovery preflight failed'}\n`);
    process.exitCode = 1;
  }
}
