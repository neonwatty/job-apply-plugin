// Required validation must fail on a hidden interpreter dependency, never skip it.
import childProcess from 'node:child_process';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

function rejectPython(command) {
  const executable = String(command).trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const name = executable?.[1] ?? executable?.[2] ?? executable?.[3] ?? String(command);
  if (/^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*|uv)(?:\.exe)?$/i.test(basename(name))) {
    const error = new Error('CPython is disabled in required TypeScript validation');
    error.code = 'PYTHON_NOT_ALLOWED';
    throw error;
  }
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const original = childProcess[name];
  const wrapped = function(command, ...args) {
    rejectPython(command);
    return Reflect.apply(original, this, [command, ...args]);
  };
  if (name === 'execFile' || name === 'exec') {
    wrapped[promisify.custom] = (...args) => {
      let child;
      const result = new Promise((resolve, reject) => {
        child = wrapped(...args, (error, stdout, stderr) => {
          if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
          else resolve({ stdout, stderr });
        });
      });
      result.child = child;
      return result;
    };
  }
  childProcess[name] = wrapped;
}
syncBuiltinESMExports();
