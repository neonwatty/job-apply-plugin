import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../apps/companion/components/title-discovery-model.ts', import.meta.url), 'utf8');
const emitted = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { parseTitleDiscoveryPacket, titleKey } = await import(
  `data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`
);

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/title-discovery/${name}.json`, import.meta.url), 'utf8'));

test('observed packet retains inspectable core, adjacent, and stretch evidence', () => {
  const packet = parseTitleDiscoveryPacket(fixture('observed'));
  assert.deepEqual(packet.suggestions.map(item => item.category), ['core', 'adjacent', 'stretch']);
  assert.ok(packet.suggestions.every(item => item.evidence[0].url.startsWith('https://www.linkedin.com/jobs/')));
  assert.equal(parseTitleDiscoveryPacket(`\`\`\`json\n${JSON.stringify(packet)}\n\`\`\``).suggestions.length, 3);
});

test('source limitations are explicit and have no evidence-backed suggestions', () => {
  const unavailable = fixture('unavailable');
  assert.equal(parseTitleDiscoveryPacket(unavailable).source.status, 'logged_out');
  for (const status of ['blocked', 'unavailable', 'empty']) {
    assert.equal(parseTitleDiscoveryPacket({ ...unavailable, source: { ...unavailable.source, status } }).suggestions.length, 0);
  }
  assert.throws(() => parseTitleDiscoveryPacket({ ...unavailable, suggestions: fixture('observed').suggestions }));
  assert.throws(() => parseTitleDiscoveryPacket({ ...fixture('observed'), source: unavailable.source }));
});

test('parser rejects invented, unsafe, or private payloads', () => {
  const observed = fixture('observed');
  const first = observed.suggestions[0];
  assert.throws(() => parseTitleDiscoveryPacket({ ...observed, resumeText: 'private' }));
  assert.throws(() => parseTitleDiscoveryPacket({ ...observed, suggestions: [{ ...first, evidence: [] }] }));
  assert.throws(() => parseTitleDiscoveryPacket({ ...observed, suggestions: [{ ...first, evidence: [{ ...first.evidence[0], url: 'file:///tmp/x' }] }] }));
  for (const url of ['http://[::1]/admin', 'http://[fc00::1]/', 'http://example.localhost/']) {
    assert.throws(() => parseTitleDiscoveryPacket({ ...observed, suggestions: [{ ...first, evidence: [{ ...first.evidence[0], url }] }] }));
  }
  const deduplicated = parseTitleDiscoveryPacket({ ...observed, suggestions: [first, { ...first, title: ' machine  learning engineer ', evidence: [{ ...first.evidence[0], url: 'https://www.linkedin.com/jobs/view/synthetic-core-2/' }] }] });
  assert.equal(deduplicated.suggestions.length, 1);
  assert.equal(deduplicated.suggestions[0].evidence.length, 2);
  assert.throws(() => parseTitleDiscoveryPacket({ ...observed, suggestions: [first, { ...first, category: 'stretch' }] }));
  assert.equal(titleKey('Staff ML Engineer'), 'staff ml engineer');
  assert.notEqual(titleKey('Senior ML Engineer'), titleKey('Staff ML Engineer'));
});
