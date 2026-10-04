#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [sourceArgument, smokeArgument] = process.argv.slice(2);
if (!sourceArgument || !smokeArgument) throw Error('usage: source_bootstrap.mjs /source/plugin /smoke/root');
const source = await realpath(resolve(sourceArgument)), smoke = await realpath(resolve(smokeArgument));
const server = join(source, 'apps/companion/.next/standalone/apps/companion/server.js');
if (await lstat(server).catch(() => null)) throw Error('source fixture already contains a Companion build');

const child = spawn(process.execPath, [join(source, 'apps/companion/launch.mjs'),
  '--plugin-root', source, '--root', join(smoke, 'source-bootstrap-store')], {
  cwd: source, stdio: ['ignore', 'pipe', 'pipe'],
});
let errors = '';
child.stderr.on('data', bytes => { errors = (errors + bytes.toString('utf8')).slice(-8192); });
async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise(resolveTimeout => setTimeout(resolveTimeout, 10_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL'); await once(child, 'exit');
  }
}
try {
  const line = await new Promise((done, fail) => {
    let output = '';
    const timer = setTimeout(() => finish(Error(`source-only Companion startup timed out: ${errors}`)), 120_000);
    function finish(error, value) {
      clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError);
      error ? fail(error) : done(value);
    }
    function onData(bytes) {
      output += bytes.toString('utf8');
      if (output.length > 16_384) return finish(Error('invalid Companion startup response'));
      const end = output.indexOf('\n'); if (end >= 0) finish(null, output.slice(0, end));
    }
    function onExit(code) { finish(Error(`source-only Companion exited ${code}: ${errors}`)); }
    function onError(error) { finish(error); }
    child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', onError);
  });
  const startup = JSON.parse(line), url = new URL(startup.url);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  if (url.origin !== startup.origin || url.hostname !== '127.0.0.1' || !token) throw Error('invalid Companion startup URL');
  const response = await fetch(`${url.origin}/api/boot`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok || (await response.json()).mode !== 'native-store-clone') throw Error('source-only Companion did not serve the native workspace');
  if (!(await lstat(server)).isFile()) throw Error('source-only Companion did not assemble its standalone build');
  process.stdout.write('Source-only Companion first launch built and served the native workspace\n');
} finally { await stop(); }
