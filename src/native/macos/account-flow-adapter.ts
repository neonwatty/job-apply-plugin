import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { get, int, object, string, fromJSON, JobsError } from '../../contracts/workspace/values.js';
import type { Document, Value } from '../../contracts/workspace/values.js';
import { validateEmailOnlyAccountResult } from '../../contracts/workspace/email-only-account.js';
import type { EmailOnlyAccountExecutor } from '../../workspace-core/email-only-account.js';
import { ReviewedMacOSHelperIdentity } from './identity.js';
import { buildReviewedOracleHelper } from './build.js';

const fingerprint = /^sha256:[0-9a-f]{64}$/;
const outcomeSet = new Set(['active', 'verification_required', 'failed_definitive', 'ambiguous']);
const closedFailureCodes = new Map<number, string>([
  [21, 'request_binding'], [22, 'private_channel'], [23, 'effect'], [24, 'email_effect'],
  [25, 'terms_effect'], [26, 'next_effect'], [27, 'clearing_effect'], [28, 'request_binding_stage'],
  [29, 'browser_binding'], [30, 'page_binding'], [31, 'control_binding'], [32, 'state_binding'],
  [33, 'causal_binding'], [34, 'browser_process'], [36, 'accessibility_trust'], [37, 'browser_activation'],
]);

function required(request: Document, field: string): string {
  const value = string(get(request, field));
  if (!value) throw new JobsError(`native email-only ${field} is invalid`);
  return value;
}

function argumentsFor(request: Document, browserPID: number): string[] {
  const portalValue = required(request, 'portalUrl'), portal = new URL(portalValue);
  if (portal.protocol !== 'https:' || (portal.port && portal.port !== '443')
    || portal.username || portal.password || portal.search || portal.hash) {
    throw new JobsError('native email-only portal is invalid');
  }
  const operation = required(request, 'operationFingerprint');
  if (!fingerprint.test(operation)) throw new JobsError('native email-only operation binding is invalid');
  const revisions = ['jobRevision', 'accountRevision', 'settingsRevision'].map(field => {
    const value = int(get(request, field));
    if (value === null || value < 1n) throw new JobsError('native email-only revision binding is invalid');
    return value.toString();
  });
  const controls = ['accountFormFingerprint', 'emailControlFingerprint', 'termsControlFingerprint',
    'termsDocumentFingerprint', 'nextControlFingerprint', 'accountCreationControlsFingerprint']
    .map(field => required(request, field));
  if (controls.some(value => !fingerprint.test(value))) throw new JobsError('native email-only control binding is invalid');
  const realm = required(request, 'realmRef'), descriptor = required(request, 'realmDescriptor');
  if (!/^[0-9a-f]{64}$/u.test(realm) || !descriptor.startsWith('oracle-recruiting:v1:')
    || createHash('sha256').update(descriptor).digest('hex') !== realm) {
    throw new JobsError('native email-only realm binding is invalid');
  }
  if (get(request, 'passwordControlFingerprint') !== null || get(request, 'createAccountControlFingerprint') !== null) {
    throw new JobsError('native email-only credential controls are forbidden');
  }
  const expectedAggregate = `sha256:${createHash('sha256').update(controls.slice(0, 5).join(':')).digest('hex')}`;
  if (controls[5] !== expectedAggregate) throw new JobsError('native email-only aggregate control binding is invalid');
  return ['oracle-email-only-inherited', String(browserPID), portalValue, realm,
    descriptor, ...controls, ...revisions, operation, '3', '4'];
}

function attestation(bytes: Buffer, operation: string): Value {
  if (bytes.length > 4096 || bytes.at(-1) !== 0x0a) throw new JobsError('native email-only attestation is invalid');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new JobsError('native email-only attestation is invalid'); }
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const keys = ['credentialProviderInvocations', 'emailFilledAttested', 'emailRemovedAttested',
    'finalActionActivated', 'nativeOriginAttested', 'nextActivatedExactlyOnce', 'operationFingerprint',
    'outcome', 'signedBrowserIdentityAttested', 'termsAcceptedAttested'];
  if (Object.keys(row).sort().join('\0') !== keys.sort().join('\0') || row.operationFingerprint !== operation
    || row.nativeOriginAttested !== true || row.signedBrowserIdentityAttested !== true
    || row.emailFilledAttested !== true || row.termsAcceptedAttested !== true
    || row.nextActivatedExactlyOnce !== true || row.emailRemovedAttested !== true
    || row.finalActionActivated !== false || row.credentialProviderInvocations !== 0
    || typeof row.outcome !== 'string' || !outcomeSet.has(row.outcome)) {
    throw new JobsError('native email-only attestation is invalid');
  }
  return fromJSON({ providerId: 'macos-accessibility', outcome: row.outcome, retryAllowed: false,
    finalActionAuthorized: false, emailRemoved: true, termsAccepted: true,
    nextActivations: 1, credentialProviderInvocations: 0 });
}

export class NativeMacOSEmailOnlyExecutor implements EmailOnlyAccountExecutor {
  readonly providerId = 'macos-accessibility';
  constructor(private readonly identity: ReviewedMacOSHelperIdentity,
    private readonly browserProcessIdentifier: number, private readonly timeoutMs = 30000) {
    if (!Number.isSafeInteger(browserProcessIdentifier) || browserProcessIdentifier <= 1) {
      throw new JobsError('native browser process identifier is invalid');
    }
  }

  static async fromReviewedSources(browserProcessIdentifier: number, buildDirectory?: string) {
    return new NativeMacOSEmailOnlyExecutor(
      await buildReviewedOracleHelper(buildDirectory), browserProcessIdentifier
    );
  }

  async execute(value: Document, privateEmail: () => string): Promise<Value> {
    const request = object(value, 'native email-only request');
    const args = argumentsFor(request, this.browserProcessIdentifier);
    const binary = await this.identity.verifiedPath();
    const email = privateEmail();
    if (!email.includes('@') || email.length > 254 || /[\r\n]/u.test(email)) {
      throw new JobsError('canonical signup identity is unavailable');
    }
    const operation = required(request, 'operationFingerprint');
    return new Promise<Value>((accept, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], env: {} });
      const nativeChannel = child.stdio[3] as Duplex | null, privateChannel = child.stdio[4] as Duplex | null;
      if (!nativeChannel || !privateChannel) {
        child.kill('SIGKILL'); reject(new JobsError('native email-only channels are unavailable')); return;
      }
      let nativeBytes = Buffer.alloc(0), outputBytes = 0, parsed: Value | null = null;
      let attested = false, settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        error ? reject(error) : parsed ? accept(parsed) : reject(new JobsError('native email-only attestation is unavailable'));
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL'); finish(new JobsError('native email-only execution timed out'));
      }, this.timeoutMs);
      for (const stream of [child.stdout, child.stderr]) stream!.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > 4096) { child.kill('SIGKILL'); finish(new JobsError('native email-only output is invalid')); }
      });
      nativeChannel.on('data', chunk => {
        if (attested) { child.kill('SIGKILL'); finish(new JobsError('native email-only attestation is invalid')); return; }
        nativeBytes = Buffer.concat([nativeBytes, chunk]);
        if (nativeBytes.length > 4096) { child.kill('SIGKILL'); finish(new JobsError('native email-only attestation is invalid')); return; }
        if (nativeBytes.at(-1) === 0x0a) {
          try {
            parsed = validateEmailOnlyAccountResult(attestation(nativeBytes, operation), this.providerId);
            attested = true;
            nativeChannel.write(Buffer.of(1));
          }
          catch { child.kill('SIGKILL'); finish(new JobsError('native email-only attestation is invalid')); }
        }
      });
      child.on('error', () => finish(new JobsError('native email-only execution failed closed')));
      nativeChannel.on('error', () => finish(new JobsError('native email-only attestation channel failed closed')));
      privateChannel.on('error', () => finish(new JobsError('native email-only private channel failed closed')));
      child.on('close', code => {
        if (code !== 0 || outputBytes !== 0) {
          finish(new JobsError(`native email-only execution failed closed (${closedFailureCodes.get(code ?? -1) ?? 'unclassified'})`));
        } else finish();
      });
      privateChannel.end(Buffer.from(email, 'utf8'));
    });
  }
}
