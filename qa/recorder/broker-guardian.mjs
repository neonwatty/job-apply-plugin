import { fstatSync } from 'node:fs';
import { loadBrokerDirectory } from './broker-build.mjs';
import { removeControl } from './broker-session.mjs';

const descriptor = 3;
try {
  const directory = loadBrokerDirectory(process.argv[2]);
  const identity = fstatSync(descriptor, { bigint: true });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {});
  try {
    await new Promise((resolve, reject) => process.stdout.write('1\n', error => error ? reject(error) : resolve()));
    for await (const _ of process.stdin) { /* Read to EOF even if the broker exits abruptly. */ }
  } finally {
    const current = fstatSync(descriptor, { bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino) removeControl(directory, descriptor);
  }
} catch {
  process.exitCode = 1;
}
