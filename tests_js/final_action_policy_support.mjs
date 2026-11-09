import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const now = '2026-08-14T16:00:00Z';
export const capability = 'd'.repeat(64);
export const fingerprint = label => 'sha256:' + createHash('sha256').update(label).digest('hex');
export const reference = (kind, number) => `${kind}:${number.toString(16).padStart(64, '0')}`;
export const sensitive = { answerRef: reference('answer', 10), questionRevision: fingerprint('question'), answerRevision: fingerprint('answer') };
export const rule = { applicationRef: reference('application', 11), origin: 'https://jobs.example.test', ats: 'greenhouse', urlFingerprint: fingerprint('url'), jobFingerprint: fingerprint('job'), formRevision: fingerprint('form'), finalControlRevision: fingerprint('control') };
export const authorization = { ...rule, resumeRevision: fingerprint('resume'), answerRevisions: [sensitive] };
export const campaignInput = { riskAcknowledged: true, applicationRules: [rule], resumeRevision: fingerprint('resume'), sensitiveAllowlist: [sensitive], confirmationAuthorityRevision: fingerprint(JSON.stringify(capability)) };
export function confirmation(claimId) {
  const event = { eventId: reference('receipt', 90), claimId, source: 'isolated_loopback', observedAt: now, confirmationRevision: fingerprint('confirmation'), activationObserved: true };
  const signed = JSON.stringify(Object.fromEntries(Object.entries(event).sort()));
  return { ...event, proof: createHmac('sha256', capability).update(signed).digest('hex') };
}
export function oracle(cases, interpreter = 'python3.12') {
  // A regular stdin fixture avoids intermittent macOS spawnSync socket EOF stalls
  // on the large malformed-document matrix. It is private, synthetic, and removed.
  const temporary = mkdtempSync(join(tmpdir(), 'policy-oracle-input-'));
  const path = join(temporary, 'request.json');
  writeFileSync(path, JSON.stringify({ cases }), { mode: 0o600 });
  const descriptor = openSync(path, 'r');
  try {
    const child = spawnSync(interpreter, ['tools/contracts/final-action-policy/reference.py'], {
      cwd: root, stdio: [descriptor, 'pipe', 'pipe'], encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error(child.error?.message ?? child.stderr);
    return JSON.parse(child.stdout);
  } finally {
    closeSync(descriptor);
    rmSync(temporary, { recursive: true, force: true });
  }
}
export function deterministicOptions(provider) {
  let ordinal = 0;
  return { provider, clock: () => new Date(now), newReference: kind => reference(kind, ++ordinal) };
}

export async function treeSnapshot(directory) {
  const { readdir, stat, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const entries = {};
  async function visit(relative = '') {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const metadata = await stat(join(directory, path));
      entries[path] = { mode: metadata.mode & 0o777 };
      if (metadata.isDirectory()) await visit(path);
      else entries[path].bytes = await readFile(join(directory, path), 'utf8');
    }
  }
  await visit();
  return entries;
}
export async function nativeCases(Policy, directory, provider, cases) {
  const { mkdir, writeFile, unlink } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  let current = now;
  const options = deterministicOptions(provider);
  const service = new Policy(directory, { ...options, clock: () => new Date(current) });
  const results = [];
  for (const item of cases) {
    try {
      current = item.now ?? now;
      let result;
      if (item.op === 'write') {
        await mkdir(dirname(join(directory, item.path)), { recursive: true });
        await writeFile(join(directory, item.path), item.value);
        result = null;
      } else if (item.op === 'remove') {
        await unlink(join(directory, item.path));
        result = null;
      } else if (item.op === 'claim') {
        const v = item.value;
        result = await service.claim(v.application_ref, v.lease_id, v.attempt_ordinal, v.observed_authorization, v.action_capability);
      } else if (item.op === 'outcome') {
        const v = item.value;
        result = await service.outcome(v.campaign_id, v.application_ref, v.lease_id, v.claim_id, v.outcome, v.confirmation_event, v.confirmation_capability);
      } else result = await service[item.op](item.value);
      results.push({ ok: result });
    } catch (error) { results.push({ error: error.message }); }
  }
  return { results, tree: { entries: await treeSnapshot(directory) } };
}
