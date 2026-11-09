import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export async function checkLinks(root, { network = true } = {}) {
  root = await realpath(root);
  const remote = new Set();
  for (const name of ['README.md', 'site/index.html']) {
    const text = await readFile(resolve(root, name), 'utf8');
    const images = /!\[[^\]]*\]\(([^\s)]+)\)/g;
    const targets = name.endsWith('.md')
      ? [...[...text.matchAll(images)].map(match => ['asset', match[1]]),
        ...[...text.replace(images, '').matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map(match => ['link', match[1]])]
      : [...text.matchAll(/\b(href|src)=["']([^"']+)["']/g)].map(match => [match[1] === 'src' ? 'asset' : 'link', match[2]]);
    const anchors = new Set([...text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)].map(match => match[1]));
    for (const [kind, raw] of targets) {
      const target = raw.replace(/^<|>$/g, '');
      if (/^https?:/.test(target)) { if (kind === 'link') remote.add(target); continue; }
      if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) continue;
      const url = new URL(target, 'https://local.invalid/');
      if (target.startsWith('#')) {
        if (!anchors.has(url.hash.slice(1))) throw Error(`${name}: missing anchor ${url.hash}`);
        continue;
      }
      const destination = await realpath(resolve(dirname(resolve(root, name)), decodeURIComponent(target.split(/[?#]/)[0])));
      if (relative(root, destination).startsWith('..')) throw Error(`${name}: link escapes repository`);

    }
  }
  for (const url of network ? remote : []) {
    let status;
    try { status = execFileSync('curl', ['--head', '--location', '--max-redirs', '3', '--connect-timeout', '5', '--max-time', '15',
      '--retry', '1', '--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', url], { encoding: 'utf8' }); }
    catch { throw Error(`Remote link failed: ${url}`); }
    if (!/^[23]\d\d$|^(401|403|405|429)$/.test(status)) throw Error(`Remote link failed (${status}): ${url}`);
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await checkLinks(fileURLToPath(new URL('../', import.meta.url)));
  console.log('Local and remote link checks passed');
}
