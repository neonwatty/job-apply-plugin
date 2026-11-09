import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './git.mjs';

export async function checkLocalLinks(root) {
  const files = git(root, ['ls-files', '-z']).split('\0').filter((file) => file.endsWith('.md'));
  const errors = [];
  for (const file of files) {
    const text = (await readFile(resolve(root, file), 'utf8')).replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#')) continue;
      const path = decodeURIComponent(target.split(/[?#]/)[0]);
      const absolute = resolve(root, dirname(file), path);
      const rel = relative(root, absolute);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        errors.push(`${file}: link escapes repository`);
      } else {
        try { await stat(absolute); } catch { errors.push(`${file}: missing local target ${target}`); }
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await checkLocalLinks(process.cwd()); console.log('Local Markdown link targets passed.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
