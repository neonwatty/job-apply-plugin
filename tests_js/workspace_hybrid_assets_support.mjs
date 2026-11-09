import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
function request(port, path, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port, path, method
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)
            }));
        });
        req.setTimeout(3000, () => req.destroy(Error('asset request timeout')));
        req.on('error', reject);
        req.end();
    });
}
async function stopOwnedChild(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return;
    const waitForExit = milliseconds => new Promise(resolve => {
        let timer;
        const finish = () => {
            clearTimeout(timer);
            child.removeListener('exit', finish);
            child.removeListener('error', finish);
            resolve(child.exitCode !== null || child.signalCode !== null);
        };
        child.once('exit', finish);
        child.once('error', finish);
        timer = setTimeout(finish, milliseconds);
        if (child.exitCode !== null || child.signalCode !== null)
            finish();
    });
    const graceful = waitForExit(1000);
    child.kill('SIGINT');
    if (await graceful)
        return;
    const forced = waitForExit(1000);
    child.kill('SIGKILL');
    if (await forced)
        return;
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    throw new Error('Owned workspace server did not exit after bounded SIGKILL wait');
}
export async function hybridAssets() {
    const temporary = await mkdtemp(join(tmpdir(), 'hybrid-assets-'));
    const child = spawn(process.env.PYTHON || 'python3', [join(root, 'scripts/job-apply-workspace.py'), '--root', temporary, '--port', '0', '--no-open', '--json'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
        stderr += chunk;
    });
    try {
        const startup = await new Promise((resolve, reject) => {
            let stdout = '';
            const timeout = setTimeout(() => reject(Error(`startup timed out: ${stderr}`)), 5000);
            child.once('error', error => {
                clearTimeout(timeout);
                reject(error);
            });
            child.once('exit', code => {
                clearTimeout(timeout);
                reject(Error(`startup exited ${code}: ${stderr}`));
            });
            child.stdout.on('data', chunk => {
                stdout += chunk;
                if (!stdout.includes('\n'))
                    return;
                clearTimeout(timeout);
                try {
                    resolve(JSON.parse(stdout.slice(0, stdout.indexOf('\n'))));
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        const port = Number(new URL(startup.url).port);
        const assets = [['/lib/helpers.js', 'workspace/lib/helpers-bridge.js'], ['/lib/helpers-original.js', 'workspace/lib/helpers.js']];
        for (const name of ['answer', 'profile', 'resume', 'trash', 'activity'])
            assets.push([`/runtime/workspace-ui/lib/${name}-view.js`, `runtime/workspace-ui/lib/${name}-view.js`]);
        for (const [url, path] of assets) {
            const bytes = await readFile(join(root, path));
            const get = await request(port, url);
            assert.equal(get.status, 200, url);
            assert.deepEqual(get.body, bytes);
            assert.equal(get.headers['content-type'], 'text/javascript; charset=utf-8');
            assert.equal(Number(get.headers['content-length']), bytes.length);
            const head = await request(port, url, 'HEAD');
            assert.equal(head.status, 200);
            assert.equal(head.body.length, 0);
            assert.equal(head.headers['content-length'], get.headers['content-length']);
            assert.equal(head.headers['content-security-policy'], get.headers['content-security-policy']);
            assert.ok(get.headers['content-security-policy']);
        }
        for (const path of ['/runtime/workspace-ui/lib/../../../../package.json', '/runtime/workspace-ui/lib/%2e%2e/profile-view.js', '/runtime/workspace-ui/lib/unknown.js', '/src/workspace-ui/lib/answer-view.ts']) {
            const result = await request(port, path);
            assert.ok([400, 404].includes(result.status), `${path}: ${result.status}`);
        }
        const unauthorized = await request(port, '/api/boot');
        assert.equal(unauthorized.status, 401);
        const bridge = await readFile(join(root, 'workspace/lib/helpers-bridge.js'), 'utf8');
        assert.match(bridge, /export \{ fileToBase64 \} from "\.\/helpers-original.js"/);
        assert.equal((bridge.match(/from "\.\.\/\.\.\/runtime\//g) || []).length, 5);
    }
    finally {
        try {
            await stopOwnedChild(child);
        }
        finally {
            await rm(temporary, {
                recursive: true, force: true
            });
        }
    }
}
