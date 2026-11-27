import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ReplayError } from './contracts.js';
export async function startServer(fixturePath, expectedFilename, shutdownToken, mode, jobId, companion = false) {
    const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
    const child = spawn(process.execPath, [serverPath, '--fixture', fixturePath, '--port', '0',
        '--expected-resume-filename', expectedFilename, ...(mode ? ['--mode', mode] : []),
        ...(jobId ? ['--job', jobId] : []), ...(companion ? ['--companion', 'true'] : [])], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), detached: !companion,
        stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, JOB_APPLY_QA_SHUTDOWN_TOKEN: shutdownToken },
    });
    return new Promise((accept, reject) => {
        let output = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); failed(); }, 10000);
        function failed() {
            clearTimeout(timer);
            reject(new ReplayError('fixture server startup failed'));
        }
        child.once('error', failed);
        child.once('exit', failed);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            output += String(chunk);
            const newline = output.indexOf('\n');
            if (newline < 0)
                return;
            clearTimeout(timer);
            child.off('exit', failed);
            child.stdout.destroy();
            child.unref();
            try {
                const value = JSON.parse(output.slice(0, newline));
                if (value.url !== `http://127.0.0.1:${value.port}` || !Number.isInteger(value.port) || !value.fixtureId)
                    throw new Error();
                accept(value);
            }
            catch {
                child.kill('SIGKILL');
                failed();
            }
        });
    });
}
export async function request(url, options = {}) {
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
}
export async function identity(state) {
    try {
        const response = await request(`${new URL(state.url).origin}/__qa/identity`, {
            headers: { 'X-QA-Run-Token': state.shutdownToken },
        });
        const value = await response.json();
        if (!response.ok || value.fixtureId !== state.fixtureId || value.jobId !== state.jobId)
            throw new Error();
    }
    catch {
        throw new ReplayError('fixture server identity mismatch');
    }
}
export async function shutdown(state, required) {
    try {
        const response = await request(`${new URL(state.url).origin}/__qa/shutdown`, {
            method: 'POST', headers: { 'X-QA-Run-Token': state.shutdownToken },
        });
        if (response.status !== 204)
            throw new Error();
    }
    catch {
        if (required)
            throw new ReplayError('fixture server shutdown failed');
    }
}
export async function serverState(state) {
    try {
        const response = await request(`${new URL(state.url).origin}/__qa/state`);
        const value = await response.json();
        if (!response.ok || !Array.isArray(value.events) || !Number.isInteger(value.finalActionActivations))
            throw new Error();
        return value;
    }
    catch {
        throw new ReplayError('fixture server state unavailable');
    }
}
