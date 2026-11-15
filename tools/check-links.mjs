import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { unescape as decodeFragment } from 'node:querystring';
import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import { parse, parseFragment } from 'parse5';

const markdown = new MarkdownIt({ html: true });
const isMarkdown = name => /\.(?:md|markdown)$/i.test(name);

function textContent(node) {
  return node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(textContent).join('');
}

function inspectDocument(text, renderedMarkdown) {
  const targets = [];
  const anchors = new Set();
  const slugger = new GithubSlugger();
  const document = renderedMarkdown ? parseFragment(markdown.render(text)) : parse(text);
  function visit(node) {
    if (renderedMarkdown && /^h[1-6]$/.test(node.tagName)) {
      anchors.add(slugger.slug(textContent(node).trim()));
    }
    for (const { name, value } of node.attrs ?? []) {
      if (!value) continue;
      if (name === 'href') targets.push(['link', value]);
      if (name === 'src') targets.push(['asset', value]);
      if (name === 'id' || (name === 'name' && node.tagName === 'a')) anchors.add(value);
    }
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(document);
  return { targets, anchors };
}

export async function checkLinks(root, { network = true } = {}) {
  root = await realpath(root);
  const remote = new Set();
  const documents = new Map();
  async function inspect(path, renderedMarkdown) {
    const cacheKey = `${renderedMarkdown}:${path}`;
    if (!documents.has(cacheKey)) {
      const text = await readFile(path, 'utf8');
      documents.set(cacheKey, inspectDocument(text, renderedMarkdown));
    }
    return documents.get(cacheKey);
  }
  for (const name of ['README.md', 'site/index.html']) {
    const source = resolve(root, name);
    const canonicalSource = await realpath(source);
    const { targets } = await inspect(canonicalSource, isMarkdown(source));
    for (const [kind, target] of targets) {
      if (/^https?:/i.test(target)) { if (kind === 'link') remote.add(target); continue; }
      if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) continue;
      const path = decodeURIComponent(target.split(/[?#]/, 1)[0]);
      const local = isMarkdown(name) && path.startsWith('/') ? resolve(root, `.${path}`) : resolve(dirname(source), path);
      const destination = path ? await realpath(local) : canonicalSource;
      const rel = relative(root, destination);
      if (rel === '..' || rel.startsWith(`..${sep}`)) throw Error(`${name}: link escapes repository`);
      const url = new URL(target, 'https://local.invalid/');
      if (kind !== 'link' || !url.hash) continue;
      const sameDocument = destination === canonicalSource;
      const renderedMarkdown = isMarkdown(path ? local : source);
      const sourceLine = url.searchParams.get('plain') === '1' && /^#L[1-9]\d*(?:-L[1-9]\d*)?$/.test(url.hash);
      const section = renderedMarkdown && !sourceLine;
      const siteAnchor = name === 'site/index.html' && sameDocument;
      if (section || siteAnchor) {
        const { anchors } = await inspect(destination, renderedMarkdown);
        const fragment = url.hash.slice(1);
        const found = anchors.has(decodeFragment(fragment)) || (siteAnchor && anchors.has(fragment));
        if (!found) throw Error(`${name}: missing anchor ${url.hash} in ${rel}`);
      }
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
