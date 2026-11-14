import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildBrokerDirectory, loadBrokerDirectory } from './broker-build.mjs';
import { boundedLines, responseFor } from './broker-protocol.mjs';
import { SessionBroker } from './broker-session.mjs';

const guardianPath = fileURLToPath(new URL('./broker-guardian.mjs', import.meta.url));
const shutdownSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

async function startGuardian(artifact, rootFd) {
  const child = spawn(process.execPath, [guardianPath, artifact], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore', rootFd],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Guardian did not start')), 2000);
      const finish = () => clearTimeout(timer);
      child.once('error', error => { finish(); reject(error); });
      child.once('exit', () => { finish(); reject(Error('Guardian exited')); });
      const lines = createInterface({ input: child.stdout });
      lines.once('line', line => {
        lines.close();
        finish();
        if (line === '1') resolve();
        else reject(Error('Guardian did not acknowledge startup'));
      });
    });
  } catch (error) {
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    throw error;
  }
  return async () => {
    child.stdin.end();
    if (await exited !== 0) throw Error('Guardian cleanup failed');
  };
}

function send(message) {
  return new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve());
  });
}

async function serve(root) {
  let broker, stopGuardian, stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.stdin.destroy();
  };
  try {
    const { artifact, cleanup } = await buildBrokerDirectory();
    try {
      broker = new SessionBroker(root, loadBrokerDirectory(artifact));
      stopGuardian = await startGuardian(artifact, broker.rootFd);
    } finally { await cleanup(); }

    for (const signal of shutdownSignals) process.on(signal, stop);
    process.stdout.on('error', stop);
    await send({ ready: true });
    for await (const line of boundedLines(process.stdin)) {
      if (stopping) break;
      await send(responseFor(broker, line));
    }
  } catch (error) {
    if (!stopping || !['ERR_STREAM_PREMATURE_CLOSE', 'EPIPE'].includes(error.code)) throw error;
  } finally {
    try {
      if (stopGuardian) {
        try { broker.clearControl(); }
        finally { await stopGuardian(); }
      }
    } finally {
      broker?.close();
      for (const signal of shutdownSignals) process.off(signal, stop);
      process.stdout.off('error', stop);
    }
  }
}

if (process.argv.length !== 4 || process.argv[2] !== '--root') {
  process.stderr.write('broker startup failed\n');
  process.exitCode = 1;
} else {
  try { await serve(process.argv[3]); }
  catch {
    process.stderr.write('filesystem broker failed\n');
    process.exitCode = 1;
  }
}
