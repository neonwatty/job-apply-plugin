import type { AccountOperationRepository } from '../../workspace-core/account-operation.js';
import { LiveEmailOnlyAccountService } from '../../workspace-core/email-only-account.js';
import type { EmailOnlyCanaryAuthority } from '../../workspace-core/email-only-account.js';
import { NativeMacOSEmailOnlyExecutor } from './account-flow-adapter.js';

/** Build the only live Oracle composition from the closed reviewed Swift source set. */
export async function createPrivateOracleCanarySession(repository: AccountOperationRepository,
  authority: EmailOnlyCanaryAuthority, browserProcessIdentifier: number, buildDirectory?: string) {
  const executor = await NativeMacOSEmailOnlyExecutor.fromReviewedSources(browserProcessIdentifier, buildDirectory);
  return new LiveEmailOnlyAccountService(repository, executor, authority);
}
