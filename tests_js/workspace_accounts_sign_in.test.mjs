import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const read=path=>readFile(join(root,path),'utf8');

test('dedicated account workspace keeps redacted configuration separate from automation authority',async()=>{
  const [legacy,legacyAutomation,automation,companion,realm]=await Promise.all([read('workspace/index.html'),read('workspace/features/automation.js'),read('apps/companion/components/Automation.tsx'),read('apps/companion/components/Companion.tsx'),read('apps/companion/components/AutomationRealm.tsx')]);
  assert.match(legacy,/id="nav-accounts"[\s\S]*Accounts &amp; Sign-in/);
  assert.match(legacy,/id="accounts-workspace"[\s\S]*Workday stays Keychain-managed[\s\S]*MyGreenhouse[\s\S]*Oracle remains email-only[\s\S]*direct Greenhouse applications require no account/);
  assert.match(companion,/navButton\('accounts','Accounts & Sign-in'\)/);
  assert.match(automation,/Saved account metadata[\s\S]*Browser session/);
  assert.match(automation,/Direct Greenhouse applications[\s\S]*Account not required[\s\S]*Unpersisted/);
  assert.match(automation,/myGreenhousePasswordlessConfigurationReady[\s\S]*myGreenhousePasswordlessExecutionReady/);
  assert.match(automation,/add\(undefined,'https:\/\/my\.greenhouse\.io\/',false\)/);
  assert.match(realm,/Keychain[\s\S]*browser-delivered email code[\s\S]*No credential provider/);
  assert.match(legacyAutomation,/\/api\/employer-accounts\/\$\{encodeURIComponent\(account\.realmRef\)\}\/delete[\s\S]*expectedRevision: account\.revision/);
  assert.match(legacyAutomation,/Remove saved account/);
  const legacyAccounts=legacy.match(/<div id="accounts-workspace"[\s\S]*?<div id="automation-workspace"/)?.[0] ?? '';
  assert.doesNotMatch(`${legacyAccounts}\n${automation}\n${realm}`,/type="(?:password|email)"|autocomplete="email"|name="signupEmail"|name="signupEmailOverride"/i);
});

test('account mutations are revisioned and public removal is allowlisted',async()=>{
  const [accounts,http,routes]=await Promise.all([read('src/workspace-core/accounts.ts'),read('src/workspace-core/automation-http.ts'),read('apps/companion/server/routes.ts')]);
  assert.match(accounts,/remove\(realmRef: string, revision: bigint\)/);
  assert.match(accounts,/employer account revision conflict/);
  assert.match(http,/\/api\\\/employer-accounts\\\/\(\[\^\/\]\+\)\\\/delete\$/);
  assert.match(routes,/"POST",\s*"\/api\/employer-accounts\/\{id\}\/delete"/);
});
