import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { proposalSchema, proposalInstructions, parseProposal, jsonSnapshot } from './model-contract.mjs';
import { codexProposalArguments, codexProposalEnvironment, codexProposalModel } from './codex-model-config.mjs';
import { boundedCodexProcess } from './codex-model-process.mjs';
import { probeCodexCapabilities, codexDigest } from './codex-model-probe.mjs';

export function codexProposalResult(result) {
  let events;
  try { events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return { text: '', completed: false, failure: 'codex_invalid_events', eventTypes: [] }; }
  if (events.some(event => !event || typeof event !== 'object' || Array.isArray(event))) {
    return { text: '', completed: false, failure: 'codex_invalid_events', eventTypes: [] };
  }
  const eventTypes = events.map(event => ({ type: event.type, itemType: event.item?.type ?? null }));
  const forbidden = events.some(event => event.type === 'turn.failed'
    || (event.item && !['agent_message', 'reasoning', 'error'].includes(event.item.type)));
  const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
  const message = messages.at(-1)?.item.text;
  let failure = result.failure;
  if (!failure && (result.code !== 0 || forbidden || !events.some(event => event.type === 'turn.completed'))) {
    failure = 'codex_incomplete_turn';
  }
  if (!failure) {
    try { parseProposal(message); } catch { failure = 'codex_invalid_proposal'; }
  }
  return { text: failure ? '' : message, completed: !failure, failure, eventTypes };
}

/** Creates a proposals-only Codex runtime; the caller alone owns fixtures and host approval channels. */
export async function createCodexModelTransport({ binary, authHome, timeoutMs = 90000 } = {}) {
  if (process.platform === 'win32') throw Error('codex_transport_platform_unverified');
  if (typeof binary !== 'string' || !isAbsolute(binary) || !(await stat(binary)).isFile()
    || typeof authHome !== 'string' || !isAbsolute(authHome) || !(await stat(authHome)).isDirectory()
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error('codex_transport_invalid_configuration');
  const root = await mkdtemp(join(tmpdir(), 'workflow-codex-proposals-'));
  let closed = false, isolation = null, lastProbe = null, cleanupConfirmed = true, active = false;
  try {
    await mkdir(join(root, 'work'), { mode: 0o700 });
    await mkdir(join(root, 'codex'), { mode: 0o700 });
    const environment = codexProposalEnvironment(root);
    const version = await boundedCodexProcess(binary, ['--version'], { environment, timeoutMs: 10000 });
    cleanupConfirmed = version.cleanupConfirmed;
    if (!cleanupConfirmed) throw Error('codex_process_cleanup_unconfirmed');
    if (version.code !== 0 || !/^codex-cli 0\.160\.0\s*$/.test(version.stdout)) throw Error('codex_transport_version_unverified');
    const catalog = await boundedCodexProcess(binary, ['debug', 'models', '--bundled'], { environment, timeoutMs: 10000 });
    cleanupConfirmed = catalog.cleanupConfirmed;
    if (!cleanupConfirmed) throw Error('codex_process_cleanup_unconfirmed');
    if (catalog.code !== 0 || catalog.failure) throw Error('codex_catalog_unavailable');
    let parsed;
    try { parsed = JSON.parse(catalog.stdout); } catch { throw Error('codex_catalog_invalid'); }
    if (!parsed.models?.some(model => model.slug === codexProposalModel)) throw Error('codex_model_metadata_unavailable');
    const schema = JSON.stringify(proposalSchema);
    await writeFile(join(root, 'catalog.json'), catalog.stdout, { mode: 0o600 });
    await writeFile(join(root, 'proposal-schema.json'), schema, { mode: 0o600 });
    const identities = { binarySha256: codexDigest(await readFile(binary)), catalogSha256: codexDigest(catalog.stdout),
      schemaSha256: codexDigest(schema), version: version.stdout.trim(), model: codexProposalModel };
    const assertIdentity = async () => {
      if (closed || codexDigest(await readFile(binary)) !== identities.binarySha256
        || codexDigest(await readFile(join(root, 'catalog.json'))) !== identities.catalogSha256
        || codexDigest(await readFile(join(root, 'proposal-schema.json'))) !== identities.schemaSha256) {
        throw Error('codex_transport_identity_changed');
      }
    };
    return Object.freeze({ kind: 'live_model', model: codexProposalModel,
      async verifyIsolation() {
        if (active) throw Error('codex_transport_busy');
        if (!cleanupConfirmed) throw Error('codex_process_cleanup_unconfirmed');
        active = true;
        try {
        await assertIdentity();
        if (!isolation) {
          const probe = await probeCodexCapabilities({ binary, root });
          lastProbe = probe;
          cleanupConfirmed = probe.process.cleanupConfirmed;
          if (!probe.passed) throw Error('codex_capability_probe_failed');
          isolation = { kind: 'isolated_json_proposals', evidence: JSON.stringify({ identities, probe,
            actualArguments: codexProposalArguments('<isolated-runtime>'),
            authBoundary: 'Only Codex loads its existing auth home; harness reads no credential files.',
            providerEquivalence: 'Inference: same pinned executable, bundled model metadata and feature config; custom probe provider replaces built-in OpenAI only for capture.' }),
          checks: { noModelComputerTools: true, noModelStoreAccess: true, noModelApprovalAccess: true, noModelNetworkTools: true } };
        }
        return jsonSnapshot(isolation);
        } finally { active = false; }
      },
      diagnostics() { return jsonSnapshot({ identities, probe: lastProbe }); },
      async next({ messages }) {
        if (active) return { text: '', completed: false, rawTrace: '{"failure":"codex_transport_busy"}' };
        active = true;
        try {
        if (!cleanupConfirmed) throw Error('codex_process_cleanup_unconfirmed');
        if (!isolation) throw Error('codex_capability_probe_required');
        await assertIdentity();
        const input = JSON.stringify({ instruction: proposalInstructions,
        messages: jsonSnapshot(messages, 262144) });
        const result = await boundedCodexProcess(binary, codexProposalArguments(root), {
          environment: codexProposalEnvironment(root, authHome), input, timeoutMs, maxBytes: 1048576 });
        cleanupConfirmed = result.cleanupConfirmed;
        const parsedResult = codexProposalResult(result);
        const rawTrace = JSON.stringify({ runtime: identities, code: result.code, processId: result.processId, signal: result.signal,
          failure: parsedResult.failure, bytes: result.bytes, eventTypes: parsedResult.eventTypes,
          stdoutSha256: codexDigest(result.stdout), stderrSha256: codexDigest(result.stderr),
          stdout: result.stdout, stderr: result.stderr, cleanupConfirmed,
          acceptedProposal: parsedResult.completed ? parsedResult.text : null });
        return { text: parsedResult.text, rawTrace, completed: parsedResult.completed };
        } catch (error) {
          const failure = /^codex_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'codex_transport_failed';
          return { text: '', completed: false, rawTrace: JSON.stringify({ failure, runtime: identities }) };
        } finally { active = false; }
      },
      assertStopped() { if (active || !cleanupConfirmed) throw Error('codex_process_cleanup_unconfirmed'); },
      async close() {
        closed = true;
        if (active || !cleanupConfirmed) throw Error('codex_process_cleanup_unconfirmed');
        await rm(root, { recursive: true, force: true });
      },
    });
  } catch (error) {
    if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
    throw error;
  }
}
