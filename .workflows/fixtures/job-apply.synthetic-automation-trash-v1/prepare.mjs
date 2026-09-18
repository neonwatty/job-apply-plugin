import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(directory, 'fixture.json');
const resumePath = join(directory, 'resume.txt');
const argumentsByName = new Map();

for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (name !== '--root' || argumentsByName.has(name) || !value) {
    throw new Error('Usage: node prepare.mjs --root /absolute/disposable/store');
  }
  argumentsByName.set(name, value);
}

const requestedRoot = argumentsByName.get('--root');
if (!requestedRoot || requestedRoot !== resolve(requestedRoot)) {
  throw new Error('The disposable Store root must be absolute');
}
const root = await realpath(requestedRoot);
if (root !== requestedRoot) throw new Error('The disposable Store root must be canonical');

const fixtureBytes = await readFile(fixturePath);
const resumeBytes = await readFile(resumePath);
const fixture = JSON.parse(fixtureBytes);
if (fixture.fixtureId !== 'job-apply.synthetic-automation-trash-v1' || fixture.syntheticOnly !== true) {
  throw new Error('Synthetic fixture identity is invalid');
}

const cli = resolve(directory, '../../../runtime/cli/native-jobs.js');
function run(command, options = [], input) {
  const stdout = execFileSync(process.execPath, [cli, '--root', root, command, ...options], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  return JSON.parse(stdout);
}

const existing = [
  run('job-get', ['--id', fixture.job.id, '--include-trashed']),
  run('resume-get', ['--id', fixture.resume.id, '--include-trashed']),
  run('answer-get', ['--key', fixture.answer.key, '--include-trashed']),
];
if (existing.some(record => record !== null)) {
  throw new Error('The synthetic journey records already exist; use a new isolated Store');
}

const job = run('job-create', ['--input', '-'], fixture.job);
const resume = run('resume-import', ['--input', '-', '--path', resumePath], {
  id: fixture.resume.id,
  label: fixture.resume.label,
});
const answer = run('answer-put', ['--input', '-'], fixture.answer);
const trashedJob = run('job-trash', ['--id', job.id, '--expected-revision', String(job.revision)]);
const trashedResume = run('resume-trash', ['--id', resume.id, '--expected-revision', String(resume.revision)]);
const trashedAnswer = run('answer-trash', ['--key', answer.key, '--expected-revision', String(answer.revision)]);
const sourceHash = createHash('sha256').update(fixtureBytes).update(resumeBytes).digest('hex');

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  fixtureId: fixture.fixtureId,
  sourceHash: `sha256:${sourceHash}`,
  prepared: true,
  trashCounts: run('trash-list').counts,
  records: {
    job: { id: trashedJob.id, revision: trashedJob.revision },
    resume: { id: trashedResume.id, revision: trashedResume.revision },
    answer: { key: trashedAnswer.key, revision: trashedAnswer.revision },
  },
})}\n`);
