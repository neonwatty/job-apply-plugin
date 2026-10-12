import { createServer } from 'node:http';
import { ownerReviewPage } from './owner-review-page.mjs';

const MAX_BODY = 1024 * 1024;

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('payload_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function createOwnerReviewServer({ expectedResume }) {
  if (!Buffer.isBuffer(expectedResume) || !expectedResume.length || expectedResume.length > MAX_BODY) {
    throw new Error('expectedResume must be a nonempty Buffer of at most 1 MiB');
  }
  const expected = Buffer.from(expectedResume);
  const counters = { uploadAttempts: 0, acceptedUploads: 0, submitAttempts: 0,
    reviewReached: false, requiredFieldsComplete: false };
  let emailComplete = false;
  let url;
  const server = createServer(async (request, response) => {
    const send = (status, result, contentType = 'application/json') => {
      response.writeHead(status, {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
      });
      response.end(contentType === 'application/json' ? JSON.stringify(result) : result);
    };
    if (request.headers.host !== new URL(url).host ||
        (request.headers.origin && request.headers.origin !== url)) {
      send(403, { error: 'origin_rejected' });
      return;
    }
    const routes = ['/', '/upload', '/continue', '/review', '/submit'];
    if (!routes.includes(request.url)) return send(404, { error: 'not_found' });
    if (request.method !== (request.url === '/' ? 'GET' : 'POST')) {
      return send(405, { error: 'method_rejected' });
    }
    if (request.url === '/') return send(200, ownerReviewPage(), 'text/html; charset=utf-8');
    if (request.headers.origin !== url) return send(403, { error: 'origin_required' });
    try {
      if (request.url === '/upload') counters.uploadAttempts += 1;
      if (request.url === '/submit') counters.submitAttempts += 1;
      const body = await readBody(request);
      if (request.url === '/upload') {
        if (counters.acceptedUploads) return send(409, { error: 'already_accepted' });
        if (!body.equals(expected)) return send(422, { error: 'resume_rejected' });
        counters.acceptedUploads += 1;
        return send(200, { accepted: true });
      }
      let fields;
      try { fields = JSON.parse(body.toString('utf8')); }
      catch { return send(400, { error: 'invalid_json' }); }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        return send(400, { error: 'invalid_fields' });
      }
      if (request.url === '/continue') {
        if (!counters.acceptedUploads) return send(409, { error: 'resume_required' });
        if (typeof fields.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
          return send(422, { error: 'email_required' });
        }
        emailComplete = true;
        return send(200, { continued: true });
      }
      if (request.url === '/review') {
        if (!emailComplete || !counters.acceptedUploads) return send(409, { error: 'previous_step_required' });
        if (!['remote', 'hybrid', 'onsite'].includes(fields.workPreference)) {
          return send(422, { error: 'work_preference_required' });
        }
        counters.requiredFieldsComplete = true;
        counters.reviewReached = true;
        return send(200, { ready: true });
      }
      return send(200, { submitted: false, attemptRecorded: true });
    } catch (error) {
      send(error.status === 413 ? 413 : 400, { error: error.status === 413 ? 'payload_too_large' : 'request_rejected' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state: () => ({ ...counters }),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
