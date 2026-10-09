import { createServer } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execute, hostEnvironment, sessionContext } from '../preparation/support.mjs';

// A dedicated profile keeps workspace filesystem restrictions and permits exactly the fixture socket.
// The network proxy has no allowed domains; direct IP traffic remains sandboxed.
export function hostOptions(socket) {
  return ['--config', 'default_permissions="attempt_eval"', '--config',
    `permissions.attempt_eval={extends=":workspace",network={enabled=true,domains={},unix_sockets={${JSON.stringify(socket)}="allow"}}}`,
    '--config', 'features.network_proxy={enabled=true,proxy_url="http://127.0.0.1:0",socks_url="http://127.0.0.1:0"}'];
}
export async function fixtureSocket(pluginRoot, fixture) {
  const { attemptSocketPath } = await import(pathToFileURL(join(pluginRoot, 'runtime/cli/attempt-protocol.js')).href);
  return attemptSocketPath(fixture.storeRoot, process.getuid());
}
export function attemptArguments({ sessionId, workspace, model, socket }) {
  return ['exec', ...(sessionId ? ['resume', sessionId] : ['-C', workspace]),
    '--skip-git-repo-check', '--ignore-rules', '--model', model, ...hostOptions(socket),
    '--config', 'model_reasoning_effort="medium"', '--config', 'approval_policy="never"',
    '--config', 'web_search="disabled"', '--json', '-'];
}
export async function attemptContext(codexHome, sessionId) {
  const context = await sessionContext(codexHome, sessionId);
  const root = join(codexHome, 'sessions');
  const files = (await readdir(root, { recursive: true })).filter(name => name.endsWith(`${sessionId}.jsonl`));
  if (files.length !== 1) throw Error('Expected one attempt evaluation session');
  const last = (await readFile(join(root, files[0]), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    .filter(event => event.type === 'turn_context').at(-1).payload;
  return { ...context, profile: last.active_permission_profile, filesystem: last.file_system_sandbox_policy,
    approvalPolicy: last.approval_policy };
}
export function validateAttemptContext(actual, { workspace, model, turn }) {
  const entries = actual?.filesystem?.entries ?? [];
  const expected = [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
    ...['slash_tmp', 'tmpdir'].map(kind => ({ path: { type: 'special', value: { kind } }, access: 'write' })),
    { path: { type: 'path', path: workspace }, access: 'write' }];
  if (actual?.count !== turn || actual.cwd !== workspace || actual.model !== model || actual.effort !== 'medium'
    || actual.sandbox?.type !== 'workspace-write' || actual.sandbox.network_access !== true
    || actual.approvalPolicy !== 'never' || actual.profile?.id !== 'attempt_eval' || actual.profile.extends !== ':workspace'
    || actual.filesystem?.kind !== 'restricted' || JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw Error('Effective attempt host configuration changed');
  }
}

// Probe the same profile before models run: exact broker socket works, unrelated Unix/TCP do not.
export async function probeHost(codexHome, fixture, socket) {
  if (process.platform !== 'darwin') throw Error('Attempt model evaluation currently requires the verified macOS host profile');
  const unrelated = join(fixture.workspace, 'unrelated-probe.sock');
  const unix = createServer(client => client.end()), tcp = createServer(client => client.end());
  try {
    await new Promise((resolve, reject) => { unix.once('error', reject); unix.listen(unrelated, resolve); });
    await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve); });
    const code = `const net=require('node:net');
      async function probe(address){return new Promise(resolve=>{const c=net.connect(address);
        c.on('connect',()=>{c.destroy();resolve('connected')});c.on('error',e=>resolve(e.code));
        c.setTimeout(2000,()=>{c.destroy();resolve('timeout')});})}
      async function proxyProbe(){return new Promise(resolve=>{const proxy=new URL(process.env.HTTP_PROXY);
        const c=net.connect({host:proxy.hostname,port:Number(proxy.port)});let response='';
        c.on('connect',()=>c.write('GET http://example.invalid/ HTTP/1.1\\r\\nHost: example.invalid\\r\\nConnection: close\\r\\n\\r\\n'));
        c.on('data',chunk=>response+=chunk);c.on('end',()=>resolve(Number(response.split(' ')[1])));
        c.on('error',e=>resolve(e.code));c.setTimeout(2000,()=>{c.destroy();resolve('timeout')});})}
      (async()=>{const results=[await probe(${JSON.stringify(socket)}),await probe(${JSON.stringify(unrelated)}),
        await probe({host:'127.0.0.1',port:${tcp.address().port}}),await proxyProbe()];console.log(JSON.stringify(results));
        if(JSON.stringify(results)!==JSON.stringify(['connected','EPERM','EPERM',403]))process.exitCode=2;})();`;
    const args = ['sandbox', '-P', 'attempt_eval', '-C', fixture.workspace, ...hostOptions(socket), process.execPath, '-e', code];
    const result = await execute('codex', args, { cwd: fixture.workspace, env: hostEnvironment(codexHome, fixture.storeRoot), timeout: 10000 });
    return { args, ...result, passed: result.code === 0 && !result.failure
      && result.stdout.trim() === '["connected","EPERM","EPERM",403]' };
  } finally {
    await Promise.all([unix, tcp].map(server => new Promise(resolve => server.close(resolve))));
  }
}
