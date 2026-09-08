import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

const execute = promisify(execFile);
const aliases = ['python3', 'python3.12', 'python3.13', 'python3.14'];
const deferred = [
  'Linux/Windows native qualification',
  'other Mac OS/CPU/runtime versions',
  'clean-host/offline customer installation',
  'browser and native account integrations',
  'physical durability and release deployment',
];
const expectedOS = { version: '26.4.1', build: '25E253' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const path = value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0');
const version = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
function requireCondition(condition, message) {
  if (!condition) throw new TypeError(message);
}
function closed(value, keys) {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Expected a closed identity record');
  requireCondition(isDeepStrictEqual(Reflect.ownKeys(value).sort(), [...keys].sort()), 'Unexpected identity fields');
  for (const key of keys) {
    requireCondition(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'), 'Identity fields must be data properties');
  }
}
function exactArray(value, length) {
  requireCondition(Array.isArray(value) && value.length === length
    && isDeepStrictEqual(Reflect.ownKeys(value), [...Array.from({ length }, (_, index) => String(index)), 'length']),
  'Expected a complete closed identity array');
}

/** Validate scope and complete shape; validation does not observe the host. */
export function validateLocalMacHost(identity) {
  closed(identity, ['schemaVersion', 'scope', 'platform', 'arch', 'macOS', 'node', 'python', 'compiler', 'deferred']);
  requireCondition(identity.schemaVersion === 1 && identity.scope === 'mac-dogfood'
    && identity.platform === 'darwin' && identity.arch === 'arm64', 'Wrong Mac dogfood scope');
  closed(identity.macOS, ['version', 'build']);
  requireCondition(isDeepStrictEqual(identity.macOS, expectedOS), 'Wrong frozen macOS version or build');
  closed(identity.node, ['requested', 'resolved', 'sha256', 'version', 'unicode']);
  requireCondition(identity.node.requested === 'process.execPath' && path(identity.node.resolved)
    && digest(identity.node.sha256) && identity.node.version === '22.22.3' && identity.node.unicode === '17.0',
  'Wrong frozen Node identity');
  exactArray(identity.python, aliases.length);
  for (const [index, python] of identity.python.entries()) {
    closed(python, ['alias', 'resolved', 'sha256', 'version', 'implementation', 'profile', 'filesystemEncoding', 'filesystemErrors']);
    requireCondition(python.alias === aliases[index] && path(python.resolved) && digest(python.sha256)
      && version(python.version) && ['3.12', '3.13', '3.14'].includes(python.profile)
      && python.version.split('.').slice(0, 2).join('.') === python.profile
      && (index === 0 || python.profile === aliases[index].slice(6))
      && python.implementation === 'CPython' && python.filesystemEncoding === 'utf-8'
      && python.filesystemErrors === 'surrogateescape', 'Invalid Python alias identity');
  }
  closed(identity.compiler, ['requested', 'resolved', 'sha256', 'version']);
  requireCondition(identity.compiler.requested === 'clang' && path(identity.compiler.resolved)
    && digest(identity.compiler.sha256) && typeof identity.compiler.version === 'string'
    && identity.compiler.version.length > 0 && Buffer.byteLength(identity.compiler.version) <= 65536
    && !identity.compiler.version.includes('\0'), 'Invalid compiler identity');
  exactArray(identity.deferred, deferred.length);
  requireCondition(isDeepStrictEqual(identity.deferred, deferred), 'Deferred qualification changed');
}

export function assertLocalMacHostUnchanged(before, after) {
  validateLocalMacHost(before);
  validateLocalMacHost(after);
  requireCondition(isDeepStrictEqual(before, after), 'Local Mac host identity changed');
}

function mismatch() {
  return Object.assign(new Error('Actual host does not match the frozen Mac dogfood host'), {
    code: 'LOCAL_MAC_HOST_MISMATCH',
  });
}
const pythonProbe = [
  'import json,os,platform,sys',
  'print(json.dumps(dict(resolved=os.path.realpath(sys.executable),version=platform.python_version(),',
  ' implementation=platform.python_implementation(),profile=".".join(map(str,sys.version_info[:2])),',
  ' filesystemEncoding=sys.getfilesystemencoding(),filesystemErrors=sys.getfilesystemencodeerrors())))',
].join('\n');
const stableStat = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs];

/** Fixed probes only; missing tools on the required host are failures, never skips. */
export async function collectLocalMacHost() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64'
    || process.versions.node !== '22.22.3' || process.versions.unicode !== '17.0') throw mismatch();
  const controller = new AbortController();
  const deadline = Date.now() + 20000;
  const timer = setTimeout(() => controller.abort(), 20000);
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  function remaining() {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0 || controller.signal.aborted) throw new Error('Local Mac identity collection timed out');
    return Math.min(10000, milliseconds);
  }
  async function run(command, args) {
    const result = await execute(command, args, {
      encoding: 'utf8', timeout: remaining(), maxBuffer: 65536, shell: false,
      killSignal: 'SIGKILL', signal: controller.signal, env: environment,
    });
    requireCondition(result.stderr === '' && Buffer.byteLength(result.stdout) <= 65536, 'Unexpected identity probe output');
    remaining();
    return result.stdout;
  }
  async function osIdentity() {
    return { version: (await run('/usr/bin/sw_vers', ['-productVersion'])).trim(),
      build: (await run('/usr/bin/sw_vers', ['-buildVersion'])).trim() };
  }
  async function resolveAlias(alias) {
    remaining();
    for (const directory of (environment.PATH ?? '').split(':')) {
      const candidate = join(directory || '.', alias);
      try {
        await access(candidate, constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
        return await realpath(candidate);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
      }
    }
    throw new Error(`Required interpreter alias unavailable: ${alias}`);
  }
  async function binaryIdentity(executable) {
    remaining();
    const resolved = await realpath(executable);
    const before = await stat(resolved, { bigint: true });
    requireCondition(before.isFile(), 'Executable is not a regular file');
    const bytes = await readFile(resolved, { signal: controller.signal });
    const after = await stat(resolved, { bigint: true });
    requireCondition(isDeepStrictEqual(stableStat(before), stableStat(after))
      && await realpath(executable) === resolved, 'Executable changed during hashing');
    remaining();
    return { resolved, sha256: hash(bytes), stat: stableStat(after) };
  }
  async function sameBinary(executable, before) {
    requireCondition(isDeepStrictEqual(await binaryIdentity(executable), before), 'Executable changed during identity probes');
  }
  try {
    const macOS = await osIdentity();
    if (!isDeepStrictEqual(macOS, expectedOS)) throw mismatch();
    const node = await binaryIdentity(process.execPath);
    requireCondition(await run(node.resolved, ['--version']) === 'v22.22.3\n', 'Node executable and process disagree');
    await sameBinary(process.execPath, node);
    const python = [];
    const binaryPins = [];
    for (const alias of aliases) {
      const resolved = await resolveAlias(alias);
      const binary = await binaryIdentity(resolved);
      const viaAlias = JSON.parse(await run(alias, ['-I', '-B', '-c', pythonProbe]));
      const viaPath = JSON.parse(await run(resolved, ['-I', '-B', '-c', pythonProbe]));
      requireCondition(isDeepStrictEqual(viaAlias, viaPath) && viaPath.resolved === resolved,
        'Python alias and resolved executable disagree');
      await sameBinary(resolved, binary);
      python.push({ alias, ...viaPath, sha256: binary.sha256 });
      binaryPins.push({ alias, binary });
    }
    const compilerPath = (await run('/usr/bin/xcrun', ['--find', 'clang'])).trim();
    requireCondition(path(compilerPath), 'Compiler lookup did not return an absolute path');
    const compiler = await binaryIdentity(compilerPath);
    const compilerVersion = await run(compiler.resolved, ['--version']);
    await sameBinary(compilerPath, compiler);
    for (const { alias, binary } of binaryPins) {
      requireCondition(await resolveAlias(alias) === binary.resolved, 'Python alias resolution changed');
      await sameBinary(binary.resolved, binary);
    }
    requireCondition(await realpath((await run('/usr/bin/xcrun', ['--find', 'clang'])).trim()) === compiler.resolved,
      'Compiler resolution changed');
    await sameBinary(compilerPath, compiler);
    await sameBinary(process.execPath, node);
    requireCondition(isDeepStrictEqual(await osIdentity(), macOS), 'OS identity changed during collection');
    const identity = { schemaVersion: 1, scope: 'mac-dogfood', platform: process.platform, arch: process.arch,
      macOS, node: { requested: 'process.execPath', resolved: node.resolved, sha256: node.sha256,
        version: process.versions.node, unicode: process.versions.unicode }, python,
      compiler: { requested: 'clang', resolved: compiler.resolved, sha256: compiler.sha256, version: compilerVersion },
      deferred: [...deferred] };
    validateLocalMacHost(identity);
    remaining();
    return identity;
  } finally {
    clearTimeout(timer);
  }
}
