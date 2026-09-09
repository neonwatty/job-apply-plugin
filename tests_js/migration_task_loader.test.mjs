import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTaskEvidence } from '../tools/migration/load-task-evidence.mjs';
import { repository, MANIFEST } from './migration_task_support.mjs';

test('task loader binds actual tested Git subject separately from later evidence commits', async () => {
  const repo = await repository();
  try {
    assert.notEqual(repo.subject, repo.evidence); assert.notEqual(repo.evidence, repo.git('rev-parse', 'HEAD'));
    const result = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(result.errors, []); assert.deepEqual([...result.acceptedTasks], ['T01.I']); assert.equal(result.acceptedPackages.size, 0);
  } finally { await repo.cleanup(); }
});
test('task loader rejects dirty and untracked evidence without executing receipt commands', async () => {
  const repo = await repository();
  try {
    await repo.write('untracked.txt', 'extra');
    assert.match((await loadTaskEvidence(repo.root, repo.context)).errors.join('\n'), /clean tracked/);
    await rm(join(repo.root, 'untracked.txt')); await repo.write('src/example.ts', 'drift');
    assert.match((await loadTaskEvidence(repo.root, repo.context)).errors.join('\n'), /clean tracked/);
    repo.git('checkout', '--', 'src/example.ts');
    repo.receipt.cells[0].command = ['sh', '-c', 'touch SHOULD_NOT_EXIST'];
    await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] }); repo.commit();
    const result = await loadTaskEvidence(repo.root, repo.context);
    assert.ok(result.errors.length); assert.equal(result.acceptedTasks.size, 0); assert.equal(repo.git('status', '--porcelain'), '');
  } finally { await repo.cleanup(); }
});
test('task loader rejects tracked symlinks, altered frozen manifests and out of scope subject edits', async () => {
  for (const kind of ['symlink', 'manifest', 'scope', 'sha', 'log']) {
    const repo = await repository();
    try {
      if (kind === 'symlink') {
        await rm(join(repo.root, 'evidence/audit.tap')); await symlink('../audit.json', join(repo.root, 'evidence/audit.tap'));
      } else if (kind === 'manifest') { repo.manifest.reviewer = 'different'; await repo.write(MANIFEST, repo.manifest); }
      else if (kind === 'log') await repo.write('evidence/audit.tap', 'fabricated');
      else if (kind === 'sha') {
        repo.receipt.subject.sha = '0'.repeat(40); await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] });
      } else {
        await repo.write('outside.txt', 'outside'); const subject = repo.commit();
        repo.receipt.subject = { sha: subject, tree: repo.git('rev-parse', 'HEAD^{tree}') };
        repo.receipt.evidenceCommit = subject;
        Object.assign(repo.receipt.review, { subjectSha: subject, subjectTree: repo.receipt.subject.tree });
        await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] });
      }
      repo.commit(); const result = await loadTaskEvidence(repo.root, repo.context);
      assert.ok(result.errors.length, kind); assert.equal(result.acceptedTasks.size, 0);
    } finally { await repo.cleanup(); }
  }
});
test('task loader preserves absent catalog behavior', async () => {
  const repo = await repository();
  try {
    await rm(join(repo.root, 'config/migration/task-contracts.json'));
    const result = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(result.errors, []); assert.equal(result.acceptedTasks.size, 0);
  } finally { await repo.cleanup(); }
});
test('task Git reads ignore replacement objects for declared immutable revisions', async () => {
  const repo = await repository();
  try {
    const { createEvidenceIO } = await import('../tools/migration/evidence-io.mjs');
    const io = await createEvidenceIO(repo.root), before = io.fileAt(repo.subject, 'src/example.ts');
    const tree = io.tree(repo.subject), diff = io.diff(repo.manifest.base, repo.subject);
    const copy = io.fileAt(repo.subject, 'src/example.ts'); copy.fill(0);
    assert.equal(io.fileAt(repo.subject, 'src/example.ts').toString(), before.toString());
    assert.equal(io.clean(), true);
    await repo.write('untracked-cache-proof.txt', 'fresh filesystem state');
    assert.equal(io.clean(), false);
    await rm(join(repo.root, 'untracked-cache-proof.txt'));
    assert.equal(io.clean(), true);
    await repo.write('src/example.ts', 'replacement bytes\n'); const replacement = repo.commit();
    repo.git('replace', repo.subject, replacement);
    assert.equal(io.revision(repo.subject), true); assert.equal(io.fileAt(repo.subject, 'src/example.ts').toString(), before.toString());
    assert.equal(io.tree(repo.subject), tree); assert.deepEqual(io.diff(repo.manifest.base, repo.subject), diff);
    assert.equal(io.ancestor(replacement, repo.subject), false);
    assert.equal(io.ancestor(replacement, repo.subject), false);
    assert.throws(() => io.fileAt(repo.subject, 'src'), /regular tracked/);
    const fresh = await createEvidenceIO(repo.root);
    assert.equal(fresh.fileAt(repo.subject, 'src/example.ts').toString(), before.toString());
  } finally { await repo.cleanup(); }
});
test('task loader reads actual object-form source-size baselines and verifies a shrinking extraction', async () => {
  const repo = await repository({ oversized: true });
  try {
    const base = JSON.parse(repo.git('show', `${repo.manifest.base}:.source-size-baseline.json`));
    assert.deepEqual(base.files['src/example.ts'], { ceiling: 601, owner: 'author', reason: 'Extract bounded helper', removalPhase: 'T01' });
    const subject = JSON.parse(repo.git('show', `${repo.subject}:.source-size-baseline.json`));
    assert.equal(subject.files['src/example.ts'].ceiling, 550);
    assert.deepEqual((await loadTaskEvidence(repo.root, repo.context)).errors, []);
  } finally { await repo.cleanup(); }
  const invalid = await repository({ oversized: true, numericBaseline: true });
  try { assert.match((await loadTaskEvidence(invalid.root, invalid.context)).errors.join('\n'), /Invalid immutable source-size baseline/); }
  finally { await invalid.cleanup(); }
});
test('task lifecycle validates staged planning, future tests, subject, evidence and receipt commits', async () => {
  const repo = await repository({ futureTest: true, lifecycle: true });
  try {
    assert.deepEqual(repo.observations.map(item => item.stage), ['activation-snapshot', 'activation', 'subject-snapshot', 'subject', 'evidence-snapshot', 'evidence', 'receipt-snapshot', 'receipt']);
    for (const { stage, result } of repo.observations) {
      assert.deepEqual(result.errors, [], stage);
      assert.equal(result.currentAcceptance, stage.startsWith('receipt') ? 'accepted' : 'open', stage);
      if (!stage.startsWith('receipt')) assert.equal(result.acceptedTasks.size, 0);
      assert.deepEqual([...result.planningTestIds.get('tests_js/audit.test.mjs')], ['audit exact input']);
    }
    assert.notEqual(repo.receipt.executionBase, repo.manifest.base);
    assert.equal(repo.receipt.diff.some(change => change.path === MANIFEST), false);
  } finally { await repo.cleanup(); }
});
test('task lifecycle opens acceptance during a frozen successor and rejects undeclared drift', async () => {
  const { activateSuccessor, completeSuccessor } = await import('./migration_task_support.mjs');
  const repo = await repository({ successor: true, lifecycle: true });
  try {
    const initial = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(initial.errors, []); assert.deepEqual([...initial.acceptedTasks], ['T01.I', 'T01.V']);
    const next = await activateSuccessor(repo);
    await repo.write('src/example.ts', 'approved successor edit\n'); await repo.observe('successor-source-snapshot', true); repo.commit();
    const pending = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(pending.errors, []); assert.equal(pending.currentAcceptance, 'open'); assert.equal(pending.acceptedTasks.size, 0); assert.equal(pending.acceptedPackages.size, 0);
    for (const observation of repo.observations) assert.deepEqual(observation.result.errors, [], observation.stage);
    next.subject = repo.git('rev-parse', 'HEAD');
    repo.catalog.environments.push({ id: 'unused-reviewed-environment', platform: 'future', node: 'future', unicode: 'future' });
    await repo.write('config/migration/task-contracts.json', repo.catalog); await repo.writeLock(); repo.commit();
    const parallelActivation = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(parallelActivation.errors, []); assert.equal(parallelActivation.currentAcceptance, 'open');
    assert.equal(parallelActivation.acceptedTasks.size, 0);
    const pendingSubject = repo.git('rev-parse', 'HEAD');
    await repo.write('undeclared.ts', 'unauthorized source\n'); repo.commit();
    const rejected = await loadTaskEvidence(repo.root, repo.context);
    assert.match(rejected.errors.join('\n'), /Undeclared pending task drift/); assert.equal(rejected.acceptedTasks.size, 0);
    repo.git('reset', '--hard', pendingSubject);
    await completeSuccessor(repo, next);
    const completed = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(completed.errors, []); assert.equal(completed.currentAcceptance, 'accepted');
    assert.deepEqual([...completed.acceptedTasks], ['T01.I', 'T01.V', 'T02.I']);
    assert.equal(completed.acceptedPackages.size, 0);
    for (const observation of repo.observations) assert.deepEqual(observation.result.errors, [], observation.stage);
  } finally { await repo.cleanup(); }
});
test('execution base cannot conceal source edits or use a fabricated review lock', async () => {
  for (const kind of ['source', 'lock']) {
    const repo = await repository();
    try {
      if (kind === 'source') repo.receipt.executionBase = repo.subject;
      else {
        await repo.write('config/migration/review-lock.json', { schemaVersion: 1, files: [] });
        const revision = repo.commit(); repo.receipt.executionBase = revision;
      }
      await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] }); repo.commit();
      const result = await loadTaskEvidence(repo.root, repo.context);
      assert.ok(result.errors.length, kind); assert.equal(result.acceptedTasks.size, 0);
    } finally { await repo.cleanup(); }
  }
});
test('accepted subject must contain its declared literal test identities even when planning deferred discovery', async () => {
  const repo = await repository({ futureTest: true });
  try {
    const { TEST, source } = await import('./migration_task_support.mjs');
    repo.git('reset', '--hard', repo.evidence);
    await repo.write(TEST, source.replace('audit exact input', 'different literal identity'));
    const subject = repo.commit(); repo.receipt.subject = { sha: subject, tree: repo.git('rev-parse', 'HEAD^{tree}') };
    repo.receipt.evidenceCommit = subject;
    Object.assign(repo.receipt.review, { subjectSha: subject, subjectTree: repo.receipt.subject.tree });
    await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] });
    await repo.writeLock(); repo.commit();
    const result = await loadTaskEvidence(repo.root, repo.context);
    assert.match(result.errors.join('\n'), /Accepted subject lacks declared literal test identities/); assert.equal(result.acceptedTasks.size, 0);
  } finally { await repo.cleanup(); }
});

test('platform task evidence binds actual conditional capture to the frozen cell environment', async () => {
  const repo = await repository({ platformConditional: true, futureTest: true, lifecycle: true });
  try {
    assert.equal(repo.catalog.environments[0].platform, process.platform);
    assert.equal(repo.receipt.cells[0].environment.platform, process.platform);
    assert.notEqual(repo.subject, repo.evidence);
    assert.deepEqual(repo.manifest.cells[0].testNames, [process.platform === 'win32' ? 'windows audit' : 'portable audit']);
    for (const observation of repo.observations) assert.deepEqual(observation.result.errors, [], observation.stage);
    assert.deepEqual(repo.observations.map(row => row.stage), ['activation-snapshot', 'activation', 'subject-snapshot', 'subject', 'evidence-snapshot', 'evidence', 'receipt-snapshot', 'receipt']);
    const result = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(result.errors, []); assert.deepEqual([...result.acceptedTasks], ['T01.I']);
  } finally { await repo.cleanup(); }
});

test('platform task evidence rejects wrong-platform same-count outputs and immutable source drift', async () => {
  const { readFile } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const { digest, createEvidenceIO } = await import('../tools/migration/evidence-io.mjs');
  const { TEST } = await import('./migration_task_support.mjs');
  const other = process.platform === 'win32' ? 'darwin' : 'win32';
  const wrong = await repository({ platformConditional: true, cellPlatform: other });
  try {
    // Frozen catalog and receipt agree with one another, but not the executed branch.
    assert.equal(wrong.receipt.cells[0].environment.platform, other);
    const result = await loadTaskEvidence(wrong.root, wrong.context);
    assert.match(result.errors.join('\n'), /Accepted subject lacks declared literal test identities/);
    assert.equal(result.acceptedTasks.size, 0);
  } finally { await wrong.cleanup(); }
  for (const kind of ['alternate-output', 'receipt-environment', 'source', 'skipped-output']) {
    const repo = await repository({ platformConditional: true });
    try {
      repo.git('reset', '--hard', repo.evidence);
      let expected = /observed TAP identities differ or reporter unsupported/;
      if (kind === 'receipt-environment') {
        repo.receipt.cells[0].environment.platform = other;
        expected = /cell command\/environment identity differs/;
      } else if (kind === 'source') {
        const original = await readFile(join(repo.root, TEST), 'utf8');
        await repo.write(TEST, original.replace("=== 'win32'", "!== 'win32'"));
        const subject = repo.commit(); repo.receipt.subject = { sha: subject, tree: repo.git('rev-parse', 'HEAD^{tree}') };
        repo.receipt.evidenceCommit = subject;
        Object.assign(repo.receipt.review, { subjectSha: subject, subjectTree: repo.receipt.subject.tree });
        expected = /Accepted subject lacks declared literal test identities/;
      } else {
        const original = await readFile(join(repo.root, TEST), 'utf8');
        const name = kind === 'alternate-output' ? (process.platform === 'win32' ? 'portable audit' : 'windows audit') : repo.manifest.cells[0].testNames[0];
        await repo.write(TEST, `import test from 'node:test';\ntest${kind === 'skipped-output' ? '.skip' : ''}(${JSON.stringify(name)},()=>1);\n`);
        const started = performance.now();
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_') && !key.startsWith('GIT_')));
        const log = execFileSync(process.execPath, ['--test', TEST], { cwd: repo.root, env, encoding: 'utf8', timeout: 10000 });
        const duration = performance.now() - started;
        await repo.write(TEST, original); await repo.write('evidence/audit.tap', log);
        repo.receipt.evidenceCommit = repo.commit();
        repo.receipt.cells[0].log.sha256 = digest(log);
        Object.assign(repo.receipt.cells[0].result, { durationMs: duration, outputBytes: Buffer.byteLength(log) });
        assert.equal((log.match(/^ok /gm) ?? []).length, 1);
        assert.notEqual(digest(log), digest(await readFile(join(repo.root, TEST))));
      }
      repo.receipt.diff = (await createEvidenceIO(repo.root)).diff(repo.receipt.executionBase, repo.receipt.subject.sha);
      await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] });
      await repo.writeLock(); repo.commit();
      const result = await loadTaskEvidence(repo.root, repo.context);
      assert.match(result.errors.join('\n'), expected, kind); assert.equal(result.acceptedTasks.size, 0);
    } finally { await repo.cleanup(); }
  }
});

test('immutable Git cache retains hot reads without increasing count or byte bounds', async () => {
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = new URL('../tools/migration/evidence-io.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const calls = new Map(), id = n => n.toString(16).padStart(40, '0');
    let fail = false;
    childProcess.execFileSync = (command, argv, options) => {
      assert.equal(command, 'git');
      assert.deepEqual(argv.slice(0, 2), ['--no-pager', '--no-replace-objects']);
      assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 8 * 1024 * 1024);
      const args = argv.slice(2), key = JSON.stringify(args);
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if (fail) throw new Error('read failed');
      if (args[0] === 'ls-tree') return Buffer.from('100644 blob ' + args.at(-1) + '\\tfile\\0');
      if (args[0] === 'cat-file') return Buffer.alloc(3 * 1024 * 1024, 65);
      return Buffer.from(id(9000));
    };
    syncBuiltinESMExports();
    const { createEvidenceIO } = await import(${JSON.stringify(moduleUrl)});
    const count = args => calls.get(JSON.stringify(args)) ?? 0;
    const io = await createEvidenceIO(process.cwd());
    for (let n = 1; n <= 4096; n++) io.tree(id(n));
    io.tree(id(1)); io.tree(id(4097)); io.tree(id(1));
    assert.equal(count(['rev-parse', id(1) + '^{tree}']), 1);
    io.tree(id(2)); assert.equal(count(['rev-parse', id(2) + '^{tree}']), 2);
    fail = true; assert.throws(() => io.tree(id(5000)), /read failed/);
    fail = false; io.tree(id(5000));
    assert.equal(count(['rev-parse', id(5000) + '^{tree}']), 2);
    const bytes = await createEvidenceIO(process.cwd());
    bytes.fileAt(id(6000), 'file'); bytes.fileAt(id(6001), 'file');
    bytes.fileAt(id(6000), 'file'); bytes.fileAt(id(6002), 'file');
    const copy = bytes.fileAt(id(6000), 'file'); copy.fill(0);
    assert.equal(bytes.fileAt(id(6000), 'file')[0], 65);
    assert.equal(count(['cat-file', 'blob', id(6000)]), 1);
    bytes.fileAt(id(6001), 'file');
    assert.equal(count(['cat-file', 'blob', id(6001)]), 2);
  `], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});

test('immutable ancestry amortizes successful heads and preserves bounded fallback', async () => {
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = new URL('../tools/migration/evidence-io.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const id = n => n.toString(16).padStart(40, '0'), calls = [];
    let failHistory = false;
    cp.execFileSync = (command, argv, options) => {
      assert.equal(command, 'git');
      assert.deepEqual(argv.slice(0, 2), ['--no-pager', '--no-replace-objects']);
      assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 8388608);
      const args = argv.slice(2); calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return Buffer.from('/nonexistent-synthetic-graph/' + args[2]);
      if (args[0] === 'rev-list') {
        if (failHistory) throw Object.assign(Error('bounded failure'), { code: 'ETIMEDOUT' });
        return Buffer.from(Array.from({ length: 200 }, (_, n) => id(n + 1)).join('\\n') + '\\n');
      }
      if (args[0] === 'merge-base') {
        if (args[2] === id(999)) throw Object.assign(Error('not ancestor'), { status: 1 });
        return Buffer.alloc(0);
      }
      return Buffer.from((args[2].startsWith(id(998)) ? id(1) : args[2].slice(0, 40)) + '\\n');
    };
    syncBuiltinESMExports();
    const { createEvidenceIO } = await import(${JSON.stringify(moduleUrl)});
    const io = await createEvidenceIO(process.cwd());
    for (let n = 1; n <= 200; n++) assert.equal(io.ancestor(id(n), id(200)), true);
    assert.equal(calls.filter(args => args[0] === 'rev-list').length, 1);
    assert.equal(calls.filter(args => args[0] === 'merge-base').length, 0);
    assert.equal(io.ancestor(id(998), id(200)), true); // absent tag-like ID takes original path
    assert.equal(io.ancestor(id(999), id(200)), false);
    assert.equal(io.ancestor(id(999), id(200)), false);
    assert.equal(calls.filter(args => args[0] === 'merge-base' && args[2] === id(999)).length, 0);
    failHistory = true;
    assert.equal(io.ancestor(id(1), id(201)), true);
    assert.equal(calls.filter(args => args[0] === 'merge-base' && args[3] === id(201)).length, 1);
    failHistory = false;
    const negatives = await createEvidenceIO(process.cwd());
    const start = calls.length;
    for (let n = 1000; n < 6000; n++) assert.equal(negatives.ancestor(id(n), id(200)), false);
    assert.equal(negatives.ancestor(id(1000), id(200)), false);
    assert.equal(calls.slice(start).filter(args => args[0] === 'merge-base').length, 0);
    assert.equal(calls.slice(start).filter(args => args[0] === 'rev-list').length, 1);
  `], { encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
});

test('immutable ancestry agrees with Git on branches tags unknown IDs and replacements', async () => {
  const repo = await repository();
  try {
    const { createEvidenceIO } = await import('../tools/migration/evidence-io.mjs');
    const base = repo.git('rev-parse', 'HEAD');
    await repo.write('left.txt', 'left'); const left = repo.commit();
    repo.git('checkout', '--detach', base);
    await repo.write('right.txt', 'right'); const right = repo.commit();
    repo.git('tag', '-a', 'synthetic-ancestor', '-m', 'synthetic', base);
    const tag = repo.git('rev-parse', 'synthetic-ancestor');
    const io = await createEvidenceIO(repo.root);
    assert.equal(io.ancestor(base, left), true); assert.equal(io.ancestor(base, right), true);
    assert.equal(io.ancestor(left, right), false); assert.equal(io.ancestor(right, left), false);
    assert.equal(io.ancestor(tag, right), true);
    assert.equal(io.ancestor('f'.repeat(40), right), false);
    assert.equal(io.ancestor(base, 'f'.repeat(40)), false);
    repo.git('replace', right, left);
    assert.equal(io.ancestor(left, right), false);
    const fresh = await createEvidenceIO(repo.root);
    assert.equal(fresh.ancestor(left, right), false); assert.equal(fresh.ancestor(base, right), true);
  } finally { await repo.cleanup(); }
});

test('ancestry invalidates positive and negative history when shallow boundaries change', async () => {
  const repo = await repository();
  try {
    const { createEvidenceIO } = await import('../tools/migration/evidence-io.mjs');
    const base = repo.git('rev-parse', 'HEAD');
    await repo.write('descendant', 'synthetic'); const head = repo.commit();
    const io = await createEvidenceIO(repo.root);
    assert.equal(io.ancestor(base, head), true);
    await repo.write('.git/shallow', head + '\n');
    assert.equal(io.ancestor(base, head), false);
    assert.equal(io.ancestor(base, head), false);
    await rm(join(repo.root, '.git/shallow'));
    assert.equal(io.ancestor(base, head), true);
  } finally { await repo.cleanup(); }
});
