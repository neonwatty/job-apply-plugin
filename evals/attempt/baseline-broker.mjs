import { baselineIdleMilliseconds } from './timing.mjs';
// Harness-owned foreground composition of the unchanged ordinary broker.
// Only its pre-acquisition idle timeout is extended while a model reads references.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [pluginRoot, root, artifact] = process.argv.slice(2);
const load = path => import(pathToFileURL(join(pluginRoot, `runtime/${path}.js`)).href);
const [{ NativeJobsRepository }, { ClaimsService }, { ApplicationAuthorityService }, { loadPosixFlockProvider },
  { runAttemptBroker }] = await Promise.all([load('store/native-jobs'), load('workspace-core/claims'),
  load('workspace-core/application-authority'), load('store/posix-flock'), load('cli/attempt-broker')]);
const provider = loadPosixFlockProvider(artifact), repository = new NativeJobsRepository(root, provider);
await runAttemptBroker(root, new ClaimsService(repository), provider, { idleMilliseconds: baselineIdleMilliseconds },
  new ApplicationAuthorityService(repository));
