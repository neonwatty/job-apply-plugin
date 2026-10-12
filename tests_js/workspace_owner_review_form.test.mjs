import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerReviewServer } from '../evals/workflows/owner-review-server.mjs';

async function fixture(t) {
  const expectedResume = Buffer.from('Fictional resume bytes\n');
  const server = await createOwnerReviewServer({ expectedResume });
  t.after(() => server.close());
  const post = (path, body, origin = server.url) => fetch(server.url + path, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  return { ...server, post, expectedResume };
}

test('review requires exact accepted bytes and all required stages; final action is counted separately', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/review', { workPreference: 'remote' })).status, 409);
  assert.equal((await f.post('/upload', Buffer.from('wrong'))).status, 422);
  assert.equal((await f.post('/continue', { email: 'candidate@example.invalid' })).status, 409);
  assert.equal((await f.post('/upload', f.expectedResume)).status, 200);
  assert.equal((await f.post('/continue', { email: '' })).status, 422);
  assert.equal((await f.post('/continue', { email: 'candidate@example.invalid' })).status, 200);
  assert.equal((await f.post('/review', { workPreference: '' })).status, 422);
  assert.equal((await f.post('/review', { workPreference: 'remote' })).status, 200);
  assert.deepEqual(f.state(), {
    uploadAttempts: 2, acceptedUploads: 1, submitAttempts: 0,
    reviewReached: true, requiredFieldsComplete: true,
  });
  assert.equal((await f.post('/submit', {})).status, 200);
  assert.equal(f.state().submitAttempts, 1);
});

test('fixture rejects foreign origins, unexpected routes, methods, and oversized payloads', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/upload', f.expectedResume, 'https://example.invalid')).status, 403);
  assert.equal((await f.post('/unknown', {})).status, 404);
  assert.equal((await fetch(f.url + '/upload')).status, 405);
  assert.equal((await f.post('/upload', Buffer.alloc(1024 * 1024 + 1))).status, 413);
  assert.equal(f.state().acceptedUploads, 0);
  const snapshot = f.state();
  snapshot.acceptedUploads = 5;
  assert.equal(f.state().acceptedUploads, 0);
});

test('page exposes required native file input and nonfinal steps with a manual final action', async t => {
  const f = await fixture(t);
  const response = await fetch(f.url);
  const html = await response.text();
  assert.match(html, /id="resume.file"[^>]*type="file"[^>]*required/);
  assert.match(html, /type="email"[^>]*required/);
  assert.match(html, /id="workPreference"[^>]*required/);
  assert.match(html, /Resume accepted/);
  assert.match(html, /input\.remove\(\)/);
  assert.match(html, /Ready for manual review/);
  assert.match(html, />Submit application<\/button>/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
});
