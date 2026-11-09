import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') throw Error('Native macOS source checks require macOS');
const shared = ['job_apply_credential_helper.swift', 'job_apply_browser_bridge.swift', 'OracleExecutableIdentity.swift',
  'NativeEmailOnlyBinding.swift', 'AccessibilityTree.swift', 'ReviewedAccountForm.swift', 'OracleBrowserIdentity.swift',
  'MacOSAccessibilityAccountFlowHelper.swift', 'OracleAccountFlowFixtures.swift'];
for (const entrypoints of [
  ['job_apply_credential_helper_tests.swift', 'job_apply_credential_helper_main.swift'],
  ['job_apply_workday_account_flow_helper.swift', 'job_apply_workday_account_flow_main.swift'],
]) {
  execFileSync('/usr/bin/xcrun', ['swiftc', '-typecheck', ...shared.concat(entrypoints).map(name => `native/macos/${name}`)],
    { stdio: 'inherit', timeout: 120_000 });
}
