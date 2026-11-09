#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ReplayError, readJson, validateFixture } from './contracts.js';
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const security = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
const staticRoutes = { '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
function send(response, status, body = '', contentType = 'application/json; charset=utf-8') {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    response.writeHead(status, { ...security, 'Content-Type': contentType, 'Content-Length': bytes.length });
    response.end(bytes);
}
function json(response, status, value) { send(response, status, JSON.stringify(value)); }
function local(request, port) { return request.headers.host === `127.0.0.1:${port}`; }
function authorized(request, port) {
    return local(request, port) && request.headers.origin === `http://127.0.0.1:${port}`
        && /^application\/json(?:;[ \t]*charset[ \t]*=[ \t]*utf-8)?$/i.test(request.headers['content-type'] ?? '');
}
function capability(request, token) {
    const supplied = request.headers['x-qa-run-token'];
    if (typeof supplied !== 'string' || supplied.length !== token.length)
        return false;
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}
async function body(request) {
    const declared = request.headers['content-length'];
    if (request.headers['transfer-encoding'] !== undefined || typeof declared !== 'string' || !/^\d+$/.test(declared) || Number(declared) > 65536)
        throw new Error();
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536)
            throw new Error();
        chunks.push(Buffer.from(chunk));
    }
    if (size !== Number(declared))
        throw new Error();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validEvent(value, fixture) {
    if (!record(value) || typeof value.type !== 'string' || typeof value.controlId !== 'string' || typeof value.stepId !== 'string')
        return false;
    const step = fixture.steps.find(item => item.id === value.stepId), entry = fixture.steps.flatMap(item => item.controls.map(control => ({ control, step: item.id }))).find(item => item.control.id === value.controlId);
    const keys = Object.keys(value).sort().join(',');
    if (value.type === 'uploaded')
        return keys === 'controlId,expectedFilenameMatched,stepId,type' && typeof value.expectedFilenameMatched === 'boolean' && entry?.step === value.stepId && entry.control.role === 'file';
    if (keys !== 'controlId,stepId,type')
        return false;
    if (value.type === 'filled')
        return entry?.step === value.stepId && entry.control.role !== 'file';
    if (value.type === 'validation')
        return entry?.step === value.stepId;
    if (value.type === 'advanced')
        return value.controlId === '' && step?.kind === 'form';
    return value.type === 'reviewed' && value.controlId === '' && step?.kind === 'review';
}
export function serve(fixture, expectedFilename, shutdownToken, requestedPort = 0) {
    const events = [];
    let finalActionActivations = 0;
    const server = createServer(async (request, response) => {
        const port = server.address().port, path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
        try {
            if (request.method === 'GET') {
                if (!local(request, port))
                    return json(response, 400, { error: 'invalid local request' });
                const asset = staticRoutes[path];
                if (asset)
                    return send(response, 200, await readFile(resolve(root, 'qa/renderer', asset[0])), asset[1]);
                if (path === '/__qa/fixture')
                    return json(response, 200, fixture);
                if (path === '/__qa/upload-policy')
                    return json(response, 200, { expectedFilename });
                if (path === '/__qa/identity')
                    return capability(request, shutdownToken) ? json(response, 200, { fixtureId: fixture.id }) : json(response, 404, { error: 'not found' });
                if (path === '/__qa/state')
                    return json(response, 200, { events: events.map(event => ({ ...event })), finalActionActivations });
                return json(response, 404, { error: 'not found' });
            }
            if (request.method !== 'POST')
                return json(response, 405, { error: 'method not allowed' });
            if (path === '/__qa/shutdown') {
                if (!local(request, port) || !capability(request, shutdownToken))
                    return json(response, 404, { error: 'not found' });
                send(response, 204);
                setImmediate(() => server.close());
                return;
            }
            if (!authorized(request, port))
                return json(response, local(request, port) ? 403 : 400, { error: 'invalid local request' });
            const value = await body(request);
            if (path === '/__qa/event') {
                if (!validEvent(value, fixture))
                    return json(response, 400, { error: 'invalid semantic event' });
                if (events.length >= 10000)
                    return json(response, 503, { error: 'event limit reached' });
                events.push({ ...value });
                return send(response, 204);
            }
            if (path === '/__qa/final-action') {
                const stepId = record(value) && Object.keys(value).length === 1 && typeof value.stepId === 'string' ? value.stepId : null;
                const step = fixture.steps.find(item => item.id === stepId);
                if (!step || step.kind !== 'review' || step.finalAction?.enabled !== true || step.finalAction.tripwire !== true)
                    return json(response, 400, { error: 'invalid final action' });
                finalActionActivations += 1;
                events.splice(0, Math.max(0, events.length - 9999));
                events.push({ type: 'final-action', stepId });
                return json(response, 409, { error: 'final action blocked by QA tripwire' });
            }
            return json(response, 404, { error: 'not found' });
        }
        catch {
            return json(response, 400, { error: 'invalid request body' });
        }
    });
    return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, '127.0.0.1', () => {
            const port = server.address().port;
            process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}`, port, fixtureId: fixture.id })}\n`);
        });
        server.once('close', resolvePromise);
    });
}
async function main(args) {
    const options = new Map();
    for (let index = 0; index < args.length; index += 2)
        options.set(args[index], args[index + 1]);
    const fixturePath = options.get('--fixture'), expected = options.get('--expected-resume-filename'), token = process.env.JOB_APPLY_QA_SHUTDOWN_TOKEN ?? randomBytes(32).toString('hex');
    if (!fixturePath || !expected)
        throw new ReplayError('invalid server arguments');
    await serve(validateFixture(await readJson(fixturePath, 'invalid fixture')), expected, token, Number(options.get('--port') ?? '0'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'fixture server failed'}\n`); process.exitCode = 2; });
