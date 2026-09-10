import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { discoverNextBrowserExports } from '../tools/migration/next-surfaces.mjs';
import { checkBrowserBindings } from '../tools/migration/browser-exports.mjs';
import ts from 'typescript';
import { nextParity } from './workspace_next_parity_support.mjs';
export async function nextSecurity() {
    const temporary = await mkdtemp(join(tmpdir(), 'companion-security-'));
    try {
        const root = fileURLToPath(new URL('../', import.meta.url));
        const componentDirectory = join(root, 'apps/companion/components');
        const components = new Map();
        for (const name of await readdir(componentDirectory)) {
            if (/\.tsx?$/.test(name)) components.set(`apps/companion/components/${name}`,
                await readFile(join(componentDirectory, name), 'utf8'));
        }
        const catalogs = ['browser-g02-next-surfaces.json', 'browser-native-answers-surfaces.json',
            'browser-native-extractions-surfaces.json'];
        const surfaces = (await Promise.all(catalogs.map(async name =>
            JSON.parse(await readFile(join(root, 'config/migration', name), 'utf8')).surfaces))).flat();
        assert.deepEqual(checkBrowserBindings(discoverNextBrowserExports(components), surfaces), []);
        const example = 'apps/companion/components/example.tsx';
        assert.deepEqual(discoverNextBrowserExports(new Map([[example,
            'export type Name = string; export interface Value {} export type { Other } from "./other"; export function View(){ return <div/>; }']])).map(row => row.name), ['View']);
        for (const source of ['export * from "./other";', 'export { value } from "./other";',
            'export { value };', 'export declare const value: string;', 'export function broken(']) {
            assert.throws(() => discoverNextBrowserExports(new Map([[example, source]])));
        }
        const emptyPath = join(temporary, 'empty-path');
        await mkdir(emptyPath);
        const store = join(temporary, 'private-store-sentinel');
        const started = Date.now();
        const failedStart = await new Promise(resolve => {
            execFile(process.execPath, [join(root, 'apps/companion/launch.mjs'),
                '--root', store, '--plugin-root', root], {
                env: { ...process.env, PATH: emptyPath }, timeout: 6000,
                killSignal: 'SIGKILL', maxBuffer: 16384,
            }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
        });
        assert.equal(failedStart.error?.code, 1);
        assert.notEqual(failedStart.error?.killed, true);
        assert.ok(Date.now() - started < 6000);
        assert.equal(failedStart.stdout, '');
        assert.match(failedStart.stderr, /Companion child failed to start|Workspace startup failed/);
        for (const privateValue of [root, store, temporary, '#token=', 'Bearer ']) {
            assert.equal(failedStart.stderr.includes(privateValue), false);
        }
        for (const name of ['config', 'routes', 'assets', 'forward']) {
            const source = await readFile(new URL(`../apps/companion/server/${name}.ts`, import.meta.url), 'utf8');
            const output = ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
                }
            }).outputText.replace(/from "\.\/(config|routes|assets)"/g, 'from "./$1.mjs"');
            await writeFile(join(temporary, `${name}.mjs`), output);
        }
        const { localConfig, validToken } = await import(pathToFileURL(join(temporary, 'config.mjs')));
        const { permittedApi } = await import(pathToFileURL(join(temporary, 'routes.mjs')));
        const { legacyAssets } = await import(pathToFileURL(join(temporary, 'assets.mjs')));
        const { forward, bounded } = await import(pathToFileURL(join(temporary, 'forward.mjs')));
        await nextParity(forward);
        for (const prefix of [false, true]) {
            let cancelled = false;
            const stream = new ReadableStream({
                start(controller) {
                    if (prefix) controller.enqueue(new Uint8Array([1, 2, 3]));
                },
                cancel() {
                    cancelled = true;
                    return new Promise(() => {});
                },
            });
            let watchdog;
            try {
                await assert.rejects(Promise.race([
                    bounded(stream, 16, 5),
                    new Promise((_, reject) => {
                        watchdog = setTimeout(() => reject(new Error('Regression watchdog expired')), 1000);
                    }),
                ]), /timed out/);
                assert.equal(cancelled, true);
            } finally {
                clearTimeout(watchdog);
            }
        }
        const token = 'synthetic_token_'.repeat(3);
        const env = {
            COMPANION_ORIGIN: 'http://127.0.0.1:41001', COMPANION_PYTHON_ORIGIN: 'http://127.0.0.1:41002', COMPANION_TOKEN: token
        };
        const config = localConfig(env);
        for (const patch of [
            {
                COMPANION_ORIGIN: 'https://127.0.0.1:41001'
            }, {
                COMPANION_ORIGIN: 'http://localhost:41001'
            },
            {
                COMPANION_ORIGIN: 'http://127.0.0.1:41001/'
            }, {
                COMPANION_ORIGIN: env.COMPANION_PYTHON_ORIGIN
            },
            {
                COMPANION_PYTHON_ORIGIN: 'http://example.invalid:41002'
            }, {
                COMPANION_TOKEN: 'short'
            },
        ])
            assert.throws(() => localConfig({
                ...env, ...patch
            }));
        assert.equal(validToken(`Bearer ${token}`, token), true);
        for (const value of [null, token, `Bearer ${token}x`, `bearer ${token}`])
            assert.equal(validToken(value, token), false);
        assert.equal(permittedApi('PATCH', '/api/jobs/encoded%2Fid'), true);
        for (const [method, path] of [['DELETE', '/api/jobs/a'], ['GET', '/api/unknown'], ['GET', '/api/jobs/%zz'], ['POST', '/api/jobs/a/unknown']])
            assert.equal(permittedApi(method, path), false);
        assert.equal(legacyAssets.has('/runtime/workspace-ui/lib/answer-view.js'), true);
        assert.equal(legacyAssets.has('/server/config.ts'), false);
        let calls = [];
        const upstream = async (url, options) => {
            calls.push({
                url, options
            });
            return new Response('{"value":9007199254740993}', {
                status: 200, headers: {
                    'Content-Type': 'application/json', 'Set-Cookie': 'private=value', 'X-Untrusted': 'no',
                    'Content-Security-Policy': "default-src 'self'",
                }
            });
        };
        function request(path = '/api/boot', method = 'GET', body, changes = {}) {
            const headers = new Headers({
                host: '127.0.0.1:41001', authorization: `Bearer ${token}`, origin: config.origin, ...changes
            });
            return new Request(config.origin + path, {
                method, headers, ...(body === undefined ? {} : {
                    body
                })
            });
        }
        async function rejected(req, kind, status) {
            calls = [];
            const response = await forward(req, kind, config, upstream);
            assert.equal(response.status, status);
            assert.equal(calls.length, 0, 'Rejected request must never reach upstream');
        }
        await rejected(request('/api/boot', 'GET', undefined, {
            host: 'evil.invalid'
        }), 'api', 403);
        await rejected(request('/api/boot', 'GET', undefined, {
            authorization: 'wrong'
        }), 'api', 401);
        await rejected(request('/api/boot?extra=1'), 'api', 404);
        await rejected(request('/api/jobs/%zz'), 'api', 400);
        await rejected(request('/api/jobs/%ff'), 'api', 400);
        for (const method of ['OPTIONS', 'PUT', 'DELETE']) {
            await rejected(request('/api/jobs', method), 'api', 405);
        }
        await rejected(request('/api/unknown'), 'api', 404);
        await rejected(request('/legacy/server/config.ts'), 'asset', 404);
        await rejected(request('/legacy/app.js', 'POST', '{}'), 'asset', 404);
        await rejected(request('/api/jobs', 'POST', '{}', {
            origin: 'http://evil.invalid'
        }), 'api', 403);
        await rejected(request('/api/jobs', 'POST', '{}', {
            'content-type': 'text/plain'
        }), 'api', 415);
        await rejected(request('/api/jobs', 'POST', '{}', {
            'content-type': 'application/json'
        }), 'api', 411);
        for (const length of ['-1', '2.5', 'NaN'])
            await rejected(request('/api/jobs', 'POST', '{}', {
                'content-type': 'application/json', 'content-length': length
            }), 'api', 411);
        await rejected(request('/api/jobs', 'POST', '{}', {
            'content-type': 'application/json', 'content-length': '3'
        }), 'api', 400);
        await rejected(request('/api/jobs', 'POST', '{}', {
            'content-type': 'application/json', 'content-length': '65537'
        }), 'api', 413);
        await rejected(request('/api/jobs', 'POST', 'x'.repeat(65537), {
            'content-type': 'application/json', 'content-length': '1'
        }), 'api', 413);
        calls = [];
        const raw = '{"integer":9007199254740993,"duplicate":1,"duplicate":2}';
        const response = await forward(request('/api/jobs', 'POST', raw, {
            'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)),
            cookie: 'private=secret', 'x-forwarded-host': 'evil.invalid', 'x-custom': 'untrusted',
        }), 'api', config, upstream);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), '{"value":9007199254740993}');
        assert.equal(calls[0].url, config.upstream + '/api/jobs');
        assert.equal(Buffer.from(calls[0].options.body).toString(), raw, 'JSON bytes must not be parsed/reencoded');
        assert.deepEqual([...calls[0].options.headers.keys()].sort(), ['authorization', 'content-type', 'origin']);
        assert.equal(calls[0].options.headers.get('origin'), config.upstream);
        assert.equal(calls[0].options.redirect, 'manual');
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(response.headers.get('x-untrusted'), null);
        assert.equal(response.headers.get('content-security-policy'), "default-src 'self'");
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await forward(request(), 'api', config, async () => new Response(null, {
            status: 302, headers: {
                Location: 'http://evil.invalid'
            }
        }))).status, 502);
        assert.equal((await forward(request(), 'api', config, async () => {
            throw Error('private upstream error');
        })).status, 502);
        let responseCancelled = false;
        const oversized = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1));
            },
            cancel() {
                responseCancelled = true;
            },
        });
        const oversizedResult = await forward(request(), 'api', config, async () => new Response(oversized));
        assert.equal(oversizedResult.status, 502);
        assert.equal(responseCancelled, true);
        calls = [];
        const head = await forward(request('/legacy/app.js', 'HEAD'), 'asset', config, upstream);
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
        assert.equal(calls[0].url, config.upstream + '/app.js');
        assert.equal(calls[0].options.headers.has('authorization'), false);
    }
    finally {
        await rm(temporary, {
            recursive: true, force: true
        });
    }
}
