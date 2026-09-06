import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const fixed = ['.codex-plugin/plugin.json', 'scripts/job-apply-store.py',
  'scripts/job-apply-task.py', 'scripts/job-apply-attempt.py', 'scripts/job-apply-workspace.py',
  'skills/answer-memory/SKILL.md', 'skills/job-apply/SKILL.md'];
export const trees = ['skills', 'runtime', 'scripts/job_apply_store', 'scripts/job_apply_workspace', 'workspace'];
const files = [...fixed, 'runtime/nested/codec.js', 'scripts/job_apply_store/io.py',
  'scripts/job_apply_workspace/handler.py', 'workspace/app.js',
  'skills/job-apply/references/runtime-contract.md', 'skills/job-search/SKILL.md'];

export async function fixture(root) {
  await mkdir(root);
  for (const relative of files) {
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, Buffer.concat([Buffer.from(`synthetic:${relative}`), Buffer.from([0, 255, 10])]));
    await chmod(path, 0o640);
    await utimes(path, 1700000000, 1700000000);
  }
  return root;
}

export async function alter(root, change) {
  const path = join(root, 'scripts/job-apply-store.py');
  const remove = (relative) => rm(join(root, relative), { recursive: true, force: true });
  if (change === null) return;
  if (change === 'extra-runtime') await writeFile(join(root, 'runtime/extra.js'), 'extra');
  else if (change === 'extra-outside') await writeFile(join(root, 'outside.txt'), 'outside');
  else if (change === 'empty-dir') await mkdir(join(root, 'runtime/empty'));
  else if (change === 'empty-trees') {
    for (const tree of trees) {
      if (tree === 'skills') {
        for (const relative of files.filter(path => path.startsWith('skills/') && !fixed.includes(path))) await remove(relative);
      } else { await remove(tree); await mkdir(join(root, tree)); }
    }
  } else if (change === 'tamper') await writeFile(path, 'tampered');
  else if (change === 'mode') await chmod(path, 0o600);
  else if (['missing-fixed', 'fixed-directory', 'fixed-link', 'dangling-link'].includes(change)) {
    await rm(path);
    if (change === 'fixed-directory') await mkdir(path);
    else if (change !== 'missing-fixed') await symlink(change === 'fixed-link' ? 'job-apply-task.py' : 'absent', path);
  } else if (['missing-tree', 'tree-file'].includes(change)) {
    await remove('runtime');
    if (change === 'tree-file') await writeFile(join(root, 'runtime'), 'not-directory');
  } else if (change === 'ancestor-file') {
    await remove('skills/answer-memory');
    await writeFile(join(root, 'skills/answer-memory'), 'not-directory');
  } else if (change === 'ancestor-link') {
    await remove('scripts'); await symlink('../source/scripts', join(root, 'scripts'));
  } else if (change === 'nested-directory-link') {
    await symlink('../../workspace', join(root, 'runtime/nested/linked'));
  } else if (change === 'nested-file-link') {
    await symlink('codec.js', join(root, 'runtime/nested/linked.js'));
  } else if (change === 'nested-fifo') {
    const run = spawnSync('mkfifo', [join(root, 'runtime/nested/pipe')], { encoding: 'utf8', timeout: 3000 });
    if (run.status !== 0) throw new Error(`Owned FIFO fixture failed: ${run.stderr}`);
  } else if (change === 'missing-nested') await remove('runtime/nested/codec.js');
  else throw new Error(`Unknown synthetic mutation: ${change}`);
}

export async function snapshot(root) {
  const rows = [];
  async function visit(path, relative) {
    const info = await lstat(path, { bigint: true });
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'fifo';
    rows.push({ path: relative, kind, mode: Number(info.mode & 0o7777n), mtimeNs: String(info.mtimeNs),
      sha256: kind === 'file' ? createHash('sha256').update(await readFile(path)).digest('hex') : null,
      target: kind === 'symlink' ? await readlink(path) : null });
    if (kind === 'directory') for (const name of (await readdir(path)).sort()) {
      await visit(join(path, name), relative === '.' ? name : `${relative}/${name}`);
    }
  }
  await visit(root, '.');
  return rows;
}
