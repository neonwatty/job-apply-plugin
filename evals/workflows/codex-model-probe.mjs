import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { codexProposalArguments, codexProposalEnvironment, codexProposalModel } from './codex-model-config.mjs';
import { boundedCodexProcess } from './codex-model-process.mjs';
import { proposalSchema } from './model-contract.mjs';

export const codexDigest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, JSON.parse(canonical(entry))]))
  : Array.isArray(value) ? value.map(entry => JSON.parse(canonical(entry))) : value);

/** Only actual outbound wire grants count; feature flags and prompts are not the proof. */
export function inspectCodexRequest(value) {
  const format = value?.text?.format;
  const schemaEqual = format?.schema !== undefined && canonical(format.schema) === canonical(proposalSchema);
  const tools = value?.tools;
  return { noTools: tools === undefined || (Array.isArray(tools) && tools.length === 0),
    schemaBound: format?.type === 'json_schema' && schemaEqual,
    model: value?.model ?? null, toolNames: Array.isArray(tools) ? tools.map(tool => tool.name ?? tool.type ?? 'unknown') : [],
    toolChoice: value?.tool_choice ?? null, keys: Object.keys(value ?? {}).sort() };
}

function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`); }

/** Fake provider performs zero inference and receives no auth; force a forbidden call to test dispatch. */
export async function probeCodexCapabilities({ binary, root }) {
  const requests = [];
  const service = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
    let bytes = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1048576) { req.destroy(); return; }
        chunks.push(chunk);
      }
    } catch { req.destroy(); return; }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks)); } catch { res.writeHead(400); res.end(); return; }
    requests.push({ ...inspectCodexRequest(body), requestSha256: codexDigest(Buffer.concat(chunks)),
      authPresent: Boolean(req.headers.authorization), input: body.input });
    if (requests.length > 2) { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = `probe_response_${requests.length}`;
    event(res, 'response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    const output = requests.length === 1
      ? { id: 'probe_call', type: 'function_call', name: 'exec_command', call_id: 'forbidden_probe_call', arguments: '{"cmd":"false"}' }
      : { id: 'probe_message', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: '{"message":"Probe completed.","action":null}', annotations: [] }] };
    event(res, 'response.output_item.added', { output_index: 0, item: output });
    event(res, 'response.output_item.done', { output_index: 0, item: output });
    event(res, 'response.completed', { response: { id, object: 'response', status: 'completed', output: [output],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  let result;
  try {
    result = await boundedCodexProcess(binary, codexProposalArguments(root, service.address().port), {
      environment: codexProposalEnvironment(root), input: 'Non-inference capability probe. Return a closed JSON proposal.', timeoutMs: 20000 });
  } finally { await new Promise(resolve => { service.close(resolve); service.closeAllConnections(); }); }
  const rejected = requests[1]?.input?.some(item => item.type === 'function_call_output'
    && item.call_id === 'forbidden_probe_call' && /unsupported|not found|unknown|unrecognized|not available/i.test(JSON.stringify(item.output)));
  return { schemaVersion: 1, kind: 'recorded_codex_wire_probe', noInference: true,
    passed: requests.length === 2 && requests.every(item => item.noTools && item.schemaBound && !item.authPresent && item.model === codexProposalModel)
      && rejected === true && !result.failure && result.code === 0,
    forbiddenCallRejected: rejected === true,
    requests: requests.map(({ input, ...safe }) => safe),
    process: { code: result.code, processId: result.processId, failure: result.failure, cleanupConfirmed: result.cleanupConfirmed, stdout: result.stdout, stderr: result.stderr, stdoutSha256: codexDigest(result.stdout), stderrSha256: codexDigest(result.stderr) },
    // Full bounded diagnostics remain in the private evaluation receipt.
    limitation: 'Custom unauthenticated fake provider; live OpenAI requests share pinned catalog/config but provider equivalence is inferred.' };
}
