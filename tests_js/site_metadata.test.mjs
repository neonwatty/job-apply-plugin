import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Read static head tags independent of attribute order or quoting style.
function attributes(html, tag) {
  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  return [...source.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].map(match =>
    Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)]
      .map(([, name, , value]) => [name.toLowerCase(), value])));
}

test('custom domain is consistent across Pages configuration and canonical/social metadata', async () => {
  const site = new URL('../site/', import.meta.url);
  const html = await readFile(new URL('index.html', site), 'utf8');
  const canonical = attributes(html, 'link').filter(tag => tag.rel === 'canonical').at(-1)?.href;
  const openGraph = attributes(html, 'meta').filter(tag => tag.property === 'og:url').at(-1)?.content;
  assert.equal((await readFile(new URL('CNAME', site), 'utf8')).trim(), 'job-apply.neonwatty.com');
  assert.equal(canonical, 'https://job-apply.neonwatty.com/');
  assert.equal(openGraph, 'https://job-apply.neonwatty.com/');
});
