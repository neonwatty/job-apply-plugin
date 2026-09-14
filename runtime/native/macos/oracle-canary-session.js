import { LiveEmailOnlyAccountService } from '../../workspace-core/email-only-account.js';
import { NativeMacOSEmailOnlyExecutor } from './account-flow-adapter.js';
/** Build the only live Oracle composition from the closed reviewed Swift source set. */
export async function createPrivateOracleCanarySession(repository, authority, browserProcessIdentifier, buildDirectory) {
    const executor = await NativeMacOSEmailOnlyExecutor.fromReviewedSources(browserProcessIdentifier, buildDirectory);
    return new LiveEmailOnlyAccountService(repository, executor, authority);
}
