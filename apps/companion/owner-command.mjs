import { join } from 'node:path';
import { parseOwnerClaimOptions, ownerClaimWorkflow } from '../../runtime/cli/owner-claim-workflow.js';
import { resolvePackagedNativeLock } from '../../runtime/package/native-lock-artifact.js';
import { activateStoreForCli, validateSupervisorRoot } from './supervise.mjs';
import { storeWriterOwnership } from './writer-route.mjs';

/** Validate the complete request before the explicit native writer activation boundary. */
export async function runOwnerCommand(args, pluginRoot, dependencies = {}) {
  if (args.includes('--native-lock')) throw new Error('packaged native lock required');
  // The parser is pure; the placeholder validates shape before touching a Store or artifact.
  const options = parseOwnerClaimOptions([...args, '--native-lock', join(pluginRoot, 'native-lock-placeholder')]);
  const validate = dependencies.validateRoot ?? validateSupervisorRoot;
  const ownership = dependencies.ownership ?? storeWriterOwnership;
  const activate = dependencies.activate ?? activateStoreForCli;
  const resolveLock = dependencies.resolveLock ?? resolvePackagedNativeLock;
  const execute = dependencies.execute ?? ownerClaimWorkflow;
  await validate(options.root);
  const owner = await ownership(options.root);
  if (owner === 'fixture' || options.command !== 'serve' && owner !== 'clone') {
    throw new Error('owner workflow requires native owner Store');
  }
  const nativeLock = await resolveLock(pluginRoot);
  if (options.command === 'serve') {
    await activate({ root: options.root, pluginRoot, nativeLock });
  }
  return execute([...args, '--native-lock', nativeLock]);
}
