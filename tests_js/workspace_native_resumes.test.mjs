import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { validateResumeContent } from '../runtime/contracts/workspace/resume-content.js';

const fixed = '2026-09-09T12:00:00Z';
const execute = promisify(execFile);
const plain = value => JSON.parse(serialize(value));
const contentRevision = value => `content_${value.repeat(32)}`;

test('native managed resumes preserve bytes, revisions, privacy and recovery', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  try {
    const root = join(await realpath(fixture.root), 'native');
    await initializeJobsFixture(root);
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    const repository = new NativeJobsRepository(root, provider);
    let revision = 0;
    const resumes = new ResumeService(repository, () => fixed, () => 'resume-generated', () => contentRevision(String(++revision)));

    await t.test('PDF, DOCX, UTF-8 and 10 MiB content boundaries fail closed', async () => {
      assert.equal(validateResumeContent('resume.pdf', Buffer.from('%PDF-1.4\n')).mediaType, 'application/pdf');
      assert.throws(() => validateResumeContent('resume.pdf', Buffer.from('not pdf')), /does not match/);
      assert.throws(() => validateResumeContent('resume.pdf', Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad])), /does not match/);
      assert.throws(() => validateResumeContent('resume.txt', Buffer.from([0xff])), /does not match/);
      assert.throws(() => validateResumeContent('resume.rtf', Buffer.from('text')), /format must/);
      assert.throws(() => validateResumeContent('resume.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 1)), /10 MiB/);
      const valid = join(fixture.root, 'valid.docx'), unsafe = join(fixture.root, 'unsafe.docx');
      const zip = `import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('[Content_Types].xml','x');z.writestr('word/document.xml','x')\nwith zipfile.ZipFile(sys.argv[2],'w') as z:z.writestr('[Content_Types].xml','x');z.writestr('word/document.xml','x');z.writestr('../escape','x')`;
      await execute('python3', ['-c', zip, valid, unsafe]);
      const validBytes = await readFile(valid), unsafeBytes = await readFile(unsafe);
      assert.equal(validateResumeContent('resume.docx', validBytes).mediaType.includes('wordprocessingml'), true);
      assert.throws(() => validateResumeContent('resume.docx', unsafeBytes), /does not match/);
    });

    await t.test('create, metadata update, replacement and default match Python records', async () => {
      const parityRoot = join(await realpath(fixture.root), 'parity-native');
      await initializeJobsFixture(parityRoot);
      const native = new ResumeService(new NativeJobsRepository(parityRoot, provider), () => fixed,
        () => 'resume-parity', () => contentRevision('p'));
      const created = await native.import(fromJSON({ id: 'resume-parity', label: ' Parity ', tags: [' one '] }), 'parity.txt', Buffer.from('one'));
      const updated = await native.update('resume-parity', fromJSON({ label: 'Updated', tags: ['two'] }), 1n);
      const selected = await native.setDefault('resume-parity', 2n);
      const replaced = await native.replace('resume-parity', 'replacement.txt', Buffer.from('two'), 2n);
      const script = `
import sys,json,importlib.util
from pathlib import Path
sys.path.insert(0,str(Path('scripts').resolve()))
spec=importlib.util.spec_from_file_location('resume_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.utc_now=lambda:'${fixed}'
s=m.Store(Path(sys.argv[1]));s.initialize();s._new_resume_content_revision=lambda:'${contentRevision('p')}'
out=[]
out.append(s.create_resume_bytes({'id':'resume-parity','label':' Parity ','tags':[' one ']},'parity.txt',b'one'))
out.append(s.update_resume('resume-parity',{'label':'Updated','tags':['two']},1))
out.append(s.set_default_resume('resume-parity',2))
out.append(s.update_resume_bytes('resume-parity','replacement.txt',b'two',2))
print(json.dumps(out))
`;
      const reference = JSON.parse((await execute('python3', ['-c', script, join(fixture.root, 'parity-python')])).stdout);
      const comparable = record => { const result = { ...record }; delete result.observedModifiedAt; delete result.originalFilename; return result; };
      assert.deepEqual([created, updated, selected, replaced].map(item => comparable(plain(item))), reference.map(comparable));
      assert.notEqual(plain(created).originalFilename, 'parity.txt');
    });

    await t.test('import, metadata, default, replace and content survive restart', async () => {
      const first = plain(await resumes.import(fromJSON({ id: 'resume-one', label: ' First ', tags: [' main '] }), 'first.txt', Buffer.from('first')));
      assert.equal(first.label, 'First'); assert.deepEqual(first.tags, ['main']); assert.equal(first.default, true);
      assert.equal((await lstat(join(root, 'resume-files/resume-one.txt'))).mode & 0o077, 0);
      const second = plain(await resumes.import(fromJSON({ id: 'resume-two', label: 'Second', default: true }), 'second.txt', Buffer.from('second')));
      assert.equal(second.default, true);
      assert.equal(plain(await resumes.get('resume-one')).revision, 2);
      await assert.rejects(resumes.import(fromJSON({ id: 'duplicate', label: 'Duplicate' }), 'copy.txt', Buffer.from('second')), /already managed/);
      const updated = plain(await resumes.update('resume-one', fromJSON({ label: 'Primary', tags: ['one', 'two'] }), 2n));
      assert.equal(updated.revision, 3);
      const selected = plain(await resumes.setDefault('resume-one', 3n));
      assert.equal(selected.default, true); assert.equal(selected.revision, 4);
      const replaced = plain(await resumes.replace('resume-one', 'primary.txt', Buffer.from('replacement'), 4n));
      assert.equal(replaced.revision, 5); assert.equal(replaced.observedSize, 11);
      const restarted = new ResumeService(new NativeJobsRepository(root, provider));
      assert.equal((await restarted.content('resume-one')).content.toString(), 'replacement');
      assert.deepEqual(plain(await restarted.list()).map(item => item.id), ['resume-one', 'resume-two']);
    });

    await t.test('HTTP validates strict base64 and redacts file identity', async () => {
      const jobs = new JobsService(repository);
      const listed = await jobsHttp(jobs, repository, 'GET', '/api/resumes');
      assert.equal(listed.status, 200); assert.equal(listed.body.includes('managedFile'), false); assert.equal(listed.body.includes('digest'), false);
      const content = await jobsHttp(jobs, repository, 'GET', '/api/resumes/resume-one/content');
      assert.equal(content.status, 200); assert.equal(content.contentType, 'text/plain; charset=utf-8'); assert.equal(content.body.toString(), 'replacement');
      const invalid = JSON.stringify({ metadata: { label: 'Bad' }, filename: 'bad.txt', content: 'YQ= =' });
      assert.equal((await jobsHttp(jobs, repository, 'POST', '/api/resumes/import', invalid)).status, 400);
      const valid = JSON.stringify({ metadata: { id: 'resume-http', label: 'HTTP' }, filename: 'http.txt', content: Buffer.from('http').toString('base64') });
      const imported = await jobsHttp(jobs, repository, 'POST', '/api/resumes/import', valid);
      assert.equal(imported.status, 200); assert.equal(JSON.parse(imported.body).id, 'resume-http');
      assert.notEqual(JSON.parse(await readFile(join(root, 'resumes.json'), 'utf8')).resumes['resume-http'].originalFilename, 'http.txt');
    });

    await t.test('CLI imports local paths through the native service with an empty PATH', async () => {
      const metadata = join(fixture.root, 'resume-input.json'), source = join(fixture.root, 'cli.txt');
      await writeFile(metadata, '{"id":"resume-cli","label":"CLI resume"}'); await writeFile(source, 'cli resume');
      const result = await execute(process.execPath, [join(process.cwd(), 'runtime/cli/native-jobs.js'), '--root', root,
        '--native-lock', fixture.receipt.artifact, 'resume-import', '--input', metadata, '--path', source], { env: { PATH: '' } });
      assert.equal(JSON.parse(result.stdout).originalFilename, 'cli.txt');
      const checked = await execute(process.execPath, [join(process.cwd(), 'runtime/cli/native-jobs.js'), '--root', root,
        '--native-lock', fixture.receipt.artifact, 'resume-check', '--id', 'resume-cli'], { env: { PATH: '' } });
      assert.equal(JSON.parse(checked.stdout).changed, false);
    });

    await t.test('concurrent default selection accepts one expected revision', async () => {
      const current = plain(await resumes.get('resume-two'));
      const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => resumes.setDefault('resume-two', BigInt(current.revision))));
      assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
      for (const item of outcomes.filter(item => item.status === 'rejected')) assert.match(item.reason.message, /revision conflict/);
    });

    await t.test('a metadata failure after byte install rolls forward exactly once', async () => {
      const current = plain(await resumes.get('resume-one'));
      let failed = false;
      const interrupted = { resumeTransaction: operation => repository.resumeTransaction(transaction => operation({
        ...transaction, save: async document => {
          if (!failed) { failed = true; throw Error('injected metadata failure'); }
          await transaction.save(document);
        },
      })) };
      await assert.rejects(new ResumeService(interrupted, () => fixed, undefined, () => contentRevision('r'))
        .replace('resume-one', 'after.txt', Buffer.from('after interruption'), BigInt(current.revision)), /injected metadata failure/);
      const recovered = plain(await resumes.get('resume-one'));
      assert.equal(recovered.revision, current.revision + 1);
      assert.equal((await resumes.content('resume-one')).content.toString(), 'after interruption');
      assert.equal(JSON.parse(await readFile(join(root, 'resume-operation.json'), 'utf8')).operation, null);
    });

    await t.test('missing, linked and permissive managed files are rejected', async () => {
      const path = join(root, 'resume-files/resume-one.txt'), backup = join(fixture.root, 'backup.txt');
      const bytes = await readFile(path); await writeFile(backup, bytes); await unlink(path);
      assert.deepEqual(plain(await resumes.check('resume-one')).exists, false);
      await assert.rejects(resumes.content('resume-one'), /unavailable/);
      await symlink(backup, path); await assert.rejects(resumes.content('resume-one'), /private and owned|unavailable/);
      await unlink(path); await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o644);
      await assert.rejects(resumes.content('resume-one'), /private and owned/);
    });
  } finally { await fixture.cleanup(); }
});
