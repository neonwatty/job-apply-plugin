import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { filesystemEncode, filesystemDecode } from '../runtime/contracts/posix-path-bytes.js';
import { resolvePosixPath } from '../runtime/contracts/posix-path.js';
import { managedResumePath } from '../runtime/store/managed-resume-path.js';
import { StoreValidationError } from '../runtime/store/validation.js';
import { codecCorpus, setup, snapshot, unavailableNames } from './posix_path_bytes_ts_support.mjs';

const primary = process.platform === 'win32' ? 'python' : 'python3';
const reference = fileURLToPath(new URL('../tools/contracts/posix-path-bytes/reference.py', import.meta.url));
const ids = ['resolve-byte-directory', 'resolve-byte-file', 'resolve-byte-link', 'resolve-byte-target',
  'resolve-dangling-byte', 'resolve-astral', 'managed-byte-leaf', 'managed-byte-parent', 'managed-byte-link-parent',
  'managed-dangling-byte-parent', 'managed-nul-leaf', 'managed-nul-parent', 'resolve-high-surrogate',
  'resolve-low-nonescape-surrogate', 'resolve-escape-surrogate', 'managed-high-surrogate-leaf'];
const oracle = [
  'import json,os,sys,platform', 'data=json.load(sys.stdin)', 'encoded=[]',
  'for value in data["strings"]:', ' try: encoded.append({"hex":os.fsencode(value).hex()})',
  ' except UnicodeEncodeError: encoded.append({"error":"UnicodeEncodeError"})',
  'print(json.dumps({"python":platform.python_version(),"encoding":sys.getfilesystemencoding(),',
  ' "errors":sys.getfilesystemencodeerrors(),"decoded":[os.fsdecode(bytes.fromhex(h)) for h in data["byteHex"]],"encoded":encoded},ensure_ascii=True))',
].join('\n');

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`POSIX byte codec matches filesystem surrogateescape: ${executable}`, (t) => {
    if (process.platform === 'win32') { t.skip('POSIX filesystem profile only'); return; }
    const corpus = codecCorpus();
    const run = spawnSync(executable, ['-I', '-c', oracle], {
      input: JSON.stringify(corpus), encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
    });
    if (run.error?.code === 'ENOENT' && executable !== primary) { t.skip('Interpreter alias unavailable'); return; }
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const reference = JSON.parse(run.stdout);
    if (executable !== primary) assert.ok(reference.python.startsWith(executable.replace('python', '') + '.'));
    assert.equal(reference.encoding, 'utf-8');
    assert.equal(reference.errors, 'surrogateescape');
    assert.equal(reference.decoded.length, corpus.byteHex.length);
    assert.equal(reference.encoded.length, corpus.strings.length);
    corpus.byteHex.forEach((hex, index) => {
      const bytes = Buffer.from(hex, 'hex');
      const copy = Buffer.from(bytes);
      assert.equal(filesystemDecode(bytes), reference.decoded[index], `decode ${hex}`);
      assert.equal(filesystemEncode(reference.decoded[index]).toString('hex'), hex, `roundtrip ${hex}`);
      assert.deepEqual(bytes, copy);
    });
    corpus.strings.forEach((value, index) => {
      const expected = reference.encoded[index];
      if (expected.error) assert.throws(() => filesystemEncode(value), (error) => error.name === expected.error);
      else assert.equal(filesystemEncode(value).toString('hex'), expected.hex);
    });
    t.diagnostic(`${reference.python}: ${corpus.byteHex.length} byte strings, ${corpus.strings.length} Unicode strings, seed ${corpus.seed}`);
  });

  test(`native POSIX byte paths match frozen Python cases: ${executable}`, async (t) => {
    if (process.platform === 'win32') { t.skip('Native Windows remains unsupported'); return; }
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 512 * 1024 });
    if (run.error?.code === 'ENOENT' && executable !== primary) { t.skip('Interpreter alias unavailable'); return; }
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.status, 'observed');
    const profile = receipt.provenance.python.split('.').slice(0, 2).join('.');
    if (executable !== primary) assert.equal(profile, executable.replace('python', ''));
    assert.deepEqual(receipt.cases.map((item) => item.id), ids);
    const fixture = await setup();
    try {
      for (const item of receipt.cases) await t.test(item.id, async (subtest) => {
        if (item.status === 'unavailable' || (!fixture.namesAvailable && unavailableNames.includes(item.id))) {
          assert.ok(unavailableNames.includes(item.id));
          subtest.skip('Native filesystem rejects invalid-byte filenames; not a passing filename cell'); return;
        }
        assert.equal(item.status, 'observed');
        assert.equal(item.unchanged, true);
        assert.deepEqual(item.after, item.before);
        const before = await snapshot(fixture.root);
        let outcome;
        try {
          const path = (item.operation === 'resolve'
            ? await resolvePosixPath(`${fixture.managed}/${item.input}`, profile)
            : await managedResumePath(fixture.managed, new Map([['storageKind', 'managed'], ['managedFile', item.input]]), profile)
          ).replace(fixture.root, '<root>');
          let pathHex;
          try { pathHex = filesystemEncode(path).toString('hex'); }
          catch (error) { assert.equal(error.name, 'UnicodeEncodeError'); pathHex = null; }
          outcome = { kind: 'path', path, pathHex };
        } catch (error) {
          outcome = { kind: 'error', name: error instanceof StoreValidationError ? 'StoreError' : error.name };
          if (outcome.name === 'StoreError') outcome.message = error.message;
        }
        assert.deepEqual(outcome, item.outcome);
        assert.deepEqual(await snapshot(fixture.root), before);
      });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test(`native byte-path encoding errors precede NUL validation: ${executable}`, async (t) => {
    if (process.platform === 'win32') { t.skip('POSIX-only native boundary'); return; }
    const names = ['\ud800\0', '\0\ud800', '\udc7f\0', '\0\udc7f', '\udc80\0', '\0\udcff'];
    const script = [
      'import json,sys,tempfile', 'from pathlib import Path', 'from types import SimpleNamespace',
      'sys.path.insert(0,"scripts")',
      'from job_apply_store.domains.resumes.storage import ResumeStorageMixin',
      'names=json.load(sys.stdin); result=[]',
      'with tempfile.TemporaryDirectory(prefix="python-byte-precedence-") as root:',
      ' instance=SimpleNamespace(resume_files_path=Path(root))',
      ' for name in names:',
      '  pair=[]',
      '  for relative in [name+"/leaf",name]:',
      '   try:',
      '    value=ResumeStorageMixin._managed_resume_path(instance,{"storageKind":"managed","managedFile":relative})',
      '    pair.append({"path":str(value).replace(root,"<root>",1)})',
      '   except Exception as error: pair.append({"error":type(error).__name__})',
      '  result.append(pair)',
      'print(json.dumps(result,ensure_ascii=True))',
    ].join('\n');
    const run = spawnSync(executable, ['-I', '-c', script], { input: JSON.stringify(names), encoding: 'utf8', timeout: 5000 });
    if (run.error?.code === 'ENOENT' && executable !== primary) { t.skip('Interpreter alias unavailable'); return; }
    assert.equal(run.status, 0, run.stderr);
    const expected = JSON.parse(run.stdout);
    const fixture = await setup();
    const profile = executable === primary ? null : executable.replace('python', '');
    try {
      const profiles = profile ? [profile] : ['3.12', '3.13', '3.14'];
      for (const selectedProfile of profiles) {
        const before = await snapshot(fixture.root);
        for (let index = 0; index < names.length; index += 1) {
          const name = names[index];
          assert.deepEqual(expected[index][0], { error: index < 4 ? 'UnicodeEncodeError' : 'ValueError' });
          await assert.rejects(managedResumePath(fixture.managed,
            new Map([['storageKind', 'managed'], ['managedFile', `${name}/leaf`]]), selectedProfile),
          (error) => error.name === expected[index][0].error);
          const leaf = await managedResumePath(fixture.managed,
            new Map([['storageKind', 'managed'], ['managedFile', name]]), selectedProfile);
          assert.deepEqual({ path: leaf.replace(fixture.managed, '<root>') }, expected[index][1]);
        }
        assert.deepEqual(await snapshot(fixture.root), before);
      }
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
}
