import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validatePrerequisiteReceipts } from './prerequisite-receipts.mjs';

const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const safePath = (value) => typeof value === 'string' && value.trim().length > 0
  && !value.startsWith('/') && !/[\\:\x00-\x1f\x7f]/.test(value)
  && !value.split('/').some((part) => ['', '.', '..', '.git'].includes(part));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const closed = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));

// Git and filesystem reads only. Receipts never supply commands to execute.
export async function loadPrerequisites(root, { requirements, registeredTests }) {
  const errors = [];
  const canonicalRoot = await realpath(root);
  async function readRepositoryFile(path) {
    if (!safePath(path)) throw new Error('Unsafe prerequisite file path');
    let current = canonicalRoot;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      current = resolve(current, parts[index]);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || (index < parts.length - 1 ? !metadata.isDirectory() : !metadata.isFile())) {
        throw new Error('Prerequisite evidence must use real repository files');
      }
    }
    return readFile(current);
  }
  const empty = () => ({ errors, acceptedReferences: new Set(), acceptedInterfaces: new Set(),
    knownReferences: new Set(), knownInterfaces: new Set(), referenceRequirements: new Map() });
  let catalog;
  try { catalog = JSON.parse(await readRepositoryFile('config/migration/prerequisite-contracts.json')); }
  catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
  if (!closed(catalog, ['schemaVersion', 'contracts', 'environments']) || catalog.schemaVersion !== 1
    || !Array.isArray(catalog.contracts) || !Array.isArray(catalog.environments)) {
    errors.push('Invalid prerequisite contract catalog'); return empty();
  }
  let receiptFile = { receipts: [] };
  try {
    receiptFile = JSON.parse(await readRepositoryFile('config/migration/prerequisite-receipts.json'));
    if (!closed(receiptFile, ['schemaVersion', 'receipts']) || receiptFile.schemaVersion !== 1
      || !Array.isArray(receiptFile.receipts)) throw new Error('Invalid prerequisite receipt file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const contracts = new Map();
  const expectedCommands = new Map();
  const knownRequirements = new Set(requirements.map((item) => item?.id));
  const knownReferences = new Set();
  const knownInterfaces = new Set();
  for (const entry of catalog.contracts) {
    if (!closed(entry, ['id', 'kind', 'requirements', 'filePaths', 'command', 'environmentId', 'author', 'reviewer'])
      || typeof entry.id !== 'string' || !entry.id.trim() || contracts.has(entry.id)
      || !['reference', 'interface'].includes(entry.kind)
      || !Array.isArray(entry.requirements) || !entry.requirements.length
      || !entry.requirements.every((id) => typeof id === 'string' && id.trim())
      || !Array.isArray(entry.filePaths) || !entry.filePaths.length || !entry.filePaths.every(safePath)
      || !Array.isArray(entry.command) || entry.command.length !== 3
      || entry.command[0] !== 'node' || entry.command[1] !== '--test'
      || !registeredTests.has(entry.command[2]) || !entry.filePaths.includes(entry.command[2])) {
      errors.push('Invalid/unregistered prerequisite contract'); continue;
    }
    const { id, ...contract } = entry;
    contracts.set(id, contract);
    (entry.kind === 'reference' ? knownReferences : knownInterfaces).add(id);
    for (const requirementId of entry.requirements) {
      if (entry.kind === 'reference') {
        const requirement = requirements.find((item) => item?.id === requirementId);
        if (!Array.isArray(requirement?.testBindings)
          || !requirement.testBindings.some((binding) => JSON.stringify(binding?.command) === JSON.stringify(entry.command))) {
          errors.push(`Reference lacks declared requirement command ${id}`);
        }
      } else knownRequirements.add(requirementId);
      expectedCommands.set(requirementId, [...(expectedCommands.get(requirementId) ?? []), entry.command]);
    }
  }
  const expectedEnvironmentDetails = new Map();
  for (const environment of catalog.environments) {
    if (!closed(environment, ['id', 'platform', 'node', 'unicode'])
      || typeof environment.id !== 'string' || expectedEnvironmentDetails.has(environment.id)) {
      errors.push('Invalid/duplicate prerequisite environment'); continue;
    }
    expectedEnvironmentDetails.set(environment.id, environment);
  }
  const files = new Map();
  const logs = new Map();
  const revisionFiles = new Map();
  const knownRevisions = new Set();
  const ancestryPairs = new Set();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (args) => execFileSync('git', args, { cwd: root, env, timeout: 5000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const receipt of receiptFile.receipts) {
    for (const revision of [receipt?.base, receipt?.head]) {
      if (!sha(revision) || knownRevisions.has(revision)) continue;
      try { git(['cat-file', '-e', `${revision}^{commit}`]); knownRevisions.add(revision); }
      catch { /* Missing revisions are rejected by the pure verifier. */ }
    }
    if (knownRevisions.has(receipt?.base) && knownRevisions.has(receipt?.head)) {
      try { git(['merge-base', '--is-ancestor', receipt.base, receipt.head]); ancestryPairs.add(`${receipt.base}:${receipt.head}`); }
      catch { /* Unrelated history cannot unlock a prerequisite. */ }
    }
    const bindings = [...(Array.isArray(receipt?.files) ? receipt.files : []), receipt?.log];
    for (const binding of bindings) {
      if (!safePath(binding?.path)) continue;
      try {
        const bytes = await readRepositoryFile(binding.path);
        files.set(binding.path, digest(bytes));
        if (binding === receipt.log) logs.set(binding.path, bytes.toString('utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!knownRevisions.has(receipt.head)) continue;
      if (!revisionFiles.has(receipt.head)) revisionFiles.set(receipt.head, new Map());
      try { revisionFiles.get(receipt.head).set(binding.path, digest(git(['show', `${receipt.head}:${binding.path}`]))); }
      catch { /* Uncommitted or missing evidence cannot satisfy the verifier. */ }
    }
  }
  const verified = validatePrerequisiteReceipts(receiptFile.receipts, { files, logs, revisionFiles,
    knownRevisions, ancestryPairs, contracts, expectedCommands, knownRequirements,
    expectedEnvironments: new Set(expectedEnvironmentDetails.keys()), expectedEnvironmentDetails });
  errors.push(...verified.errors);
  if (errors.length) return empty();
  return { ...verified, knownReferences, knownInterfaces,
    referenceRequirements: new Map([...contracts].filter(([, contract]) => contract.kind === 'reference')
      .map(([id, contract]) => [id, new Set(contract.requirements)])) };
}
