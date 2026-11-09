import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  localRoot = join(repositoryRoot, '.workflows/local'),
} = {}) {
  const layout = applicationRecoveryLayout(journeyRoot);
  if (dirname(journeyRoot) !== localRoot
      || !/^application-recovery-[a-z0-9-]{8,64}$/.test(basename(journeyRoot))) {
    throw new Error('Journey root must be a fresh direct child of the application-recovery local root');
  }
  const localMetadata = await lstat(localRoot);
  if (!localMetadata.isDirectory() || localMetadata.isSymbolicLink()
      || localMetadata.uid !== process.getuid?.() || localMetadata.mode & 0o077
      || await realpath(localRoot) !== localRoot) {
    throw new Error('Application-recovery local root must be a private owned real directory');
  }
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
  const { probeFixtureControl } = await import(pathToFileURL(fixtureControlPath).href);
  if (typeof probeFixtureControl !== 'function') {
    throw new Error('job-apply.fixture-control has no probe; do not start training');
  }
  const capabilityContract = await probeFixtureControl();
  if (capabilityContract?.id !== 'job-apply.fixture-control'
      || !capabilityContract.operations?.includes('synthetic-review-handoff')) {
    throw new Error('job-apply.fixture-control probe did not establish the required capability');
  }
  return { ...layout, fixtureControlPath, capabilityContract };
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (key !== '--journey-root' || !value || values.has(key)) {
      throw new Error('Usage: node host-preflight.mjs --journey-root /absolute/fresh/root');
    }
    values.set(key, value);
  }
  const journeyRoot = values.get('--journey-root');
  if (!journeyRoot) throw new Error('Missing --journey-root');
  return {
    journeyRoot,
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
