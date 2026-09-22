import { lstat, realpath, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(fixtureDirectory, '../../..');

function contained(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export function applicationSetupPreferencesLayout(journeyRoot, isolatedCodexHome) {
  if (!isAbsolute(journeyRoot) || journeyRoot !== resolve(journeyRoot)) {
    throw new Error('The application-setup journey root must be absolute');
  }
  if (!isAbsolute(isolatedCodexHome) || isolatedCodexHome !== resolve(isolatedCodexHome)) {
    throw new Error('The isolated Codex home must be absolute');
  }
  const runnerStoreRoot = join(journeyRoot, 'runner-store');
  const qaRunsRoot = join(journeyRoot, 'qa-runs');
  const receiptRoot = join(journeyRoot, 'agent-receipts');
  const legacyProfilePath = join(journeyRoot, 'no-legacy-profile.json');
  const paths = [runnerStoreRoot, qaRunsRoot, isolatedCodexHome, receiptRoot];
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (contained(paths[left], paths[right]) || contained(paths[right], paths[left])) {
        throw new Error('Runner, QA, Codex, and receipt roots must be separate');
      }
    }
  }
  return { journeyRoot, runnerStoreRoot, qaRunsRoot, isolatedCodexHome, receiptRoot, legacyProfilePath };
}

async function absent(path, label) {
  try { await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  throw new Error(`${label} must be absent for a fresh application-setup journey`);
}

async function regular(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is unavailable`);
  return readFile(path, 'utf8');
}

export async function probeApplicationSetupPreferences(repositoryRoot = defaultRepositoryRoot) {
  const manifest = JSON.parse(await regular(join(repositoryRoot, '.codex-plugin/plugin.json'), 'Plugin manifest'));
  const skill = await regular(join(repositoryRoot, 'skills/application-setup/SKILL.md'), 'Application Setup skill');
  await regular(join(repositoryRoot, 'apps/companion/command.mjs'), 'Command router');
  await regular(join(repositoryRoot, 'runtime/cli/native-qa-replay.js'), 'QA route resolver');
  await regular(join(repositoryRoot, '.agents/plugins/marketplace.json'), 'Local marketplace');
  if (manifest.name !== 'job-apply' || !/^[^+]+\+codex\.[0-9]+$/.test(manifest.version)
      || !skill.includes('name: application-setup') || !skill.includes('profile-patch')) {
    throw new Error('Application Setup plugin contract is unavailable');
  }
  return {
    schema: 'agent-workflow-capability/v1', id: 'job-apply.local-agent-control', contractVersion: '1.0',
    adapter: { id: 'job-apply.synthetic-application-setup-preferences-v1', version: '1.0' },
    operations: ['fresh-setup-writer', 'fresh-setup-reader'], evidenceTypes: [],
    constraints: { localOnly: true, loopbackOnly: true, syntheticOnly: true,
      canonicalStoreAccess: false, externalNavigation: false, finalSubmission: false },
    probe: { safe: true, operation: 'probe-local-agent-control' },
  };
}

export async function applicationSetupPreferencesHostPreflight({
  journeyRoot,
  isolatedCodexHome,
  repositoryRoot = defaultRepositoryRoot,
  localRoot = join(repositoryRoot, '.workflows/local'),
} = {}) {
  const layout = applicationSetupPreferencesLayout(journeyRoot, isolatedCodexHome);
  if (dirname(journeyRoot) !== localRoot
      || !/^application-setup-preferences-[a-z0-9-]{8,64}$/.test(basename(journeyRoot))) {
    throw new Error('Journey root must be a fresh direct child of the application-setup local root');
  }
  if (contained(repositoryRoot, isolatedCodexHome)) {
    throw new Error('Isolated Codex home must be outside the plugin source to prevent recursive installation');
  }
  const localMetadata = await lstat(localRoot);
  if (!localMetadata.isDirectory() || localMetadata.isSymbolicLink()
      || localMetadata.uid !== process.getuid?.() || localMetadata.mode & 0o077
      || await realpath(localRoot) !== localRoot) {
    throw new Error('Application-setup local root must be a private owned real directory');
  }
  await absent(layout.journeyRoot, 'Journey root');
  await absent(layout.isolatedCodexHome, 'Isolated Codex home');
  await absent(layout.legacyProfilePath, 'Legacy profile path');
  return { ...layout, capabilityContract: await probeApplicationSetupPreferences(repositoryRoot) };
}

function parseArgs(args) {
  if (args.length !== 4 || args[0] !== '--journey-root' || !args[1]
      || args[2] !== '--codex-home' || !args[3]) {
    throw new Error('Usage: node host-preflight.mjs --journey-root /absolute/fresh/root --codex-home /absolute/fresh/codex-home');
  }
  return { journeyRoot: args[1], isolatedCodexHome: args[3] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify({
      schema: 'job-apply-application-setup-preferences-host-preflight/v1', ready: true,
      ...await applicationSetupPreferencesHostPreflight(parseArgs(process.argv.slice(2))),
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Application-setup preflight failed'}\n`);
    process.exitCode = 1;
  }
}
