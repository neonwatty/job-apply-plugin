import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { installedFixture, durableSnapshot, readDocument } from '../../tests_js/workspace_installed_workflows_support.mjs';
import { prepareInstalledCampaign } from './scenarios.mjs';
import { hostBrowserPage, initialValues, expectedValues } from './host-browser-page.mjs';
import { immutableDigest, gradeHostBrowser } from './host-browser-grade.mjs';
const scenarios = ['controls-handoff', 'uncertain-resume', 'stale-report'];
async function body(request) {
  let bytes = 0, text = '';
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8192) throw Object.assign(Error('payload_too_large'), { status: 413 });
    text += chunk;
  }
  try { return JSON.parse(text); } catch { throw Object.assign(Error('invalid_json'), { status: 400 }); }
}
export async function createHostBrowserFixture({ outputDirectory, scenario }) {
  if (!scenarios.includes(scenario)) throw Error('Unknown scenario');
  outputDirectory = resolve(outputDirectory);
  await mkdir(outputDirectory, { mode: 0o700 });
  await mkdir(join(outputDirectory, 'grades'), { mode: 0o700 });
  const state = await installedFixture();
  let broker, server, stopped = false, gradeNumber = 0;
  const token = randomUUID(), receipts = [];
  const page = { values: { ...initialValues }, inputCounts: {}, changeCounts: {}, submitAttempts: 0, rejectedEvents: 0, events: [] };
  const pageSnapshot = () => structuredClone(page);
  async function inspect() {
    const jobs = await readDocument(state.root, 'jobs.json');
    const coordinator = await readDocument(state.root, 'coordinator.json');
    return { page: pageSnapshot(), canonical: { job: jobs.jobs.job, otherJob: jobs.jobs.other,
      claimActive: coordinator.claim !== null, immutableDigest: immutableDigest(await durableSnapshot(state.root)),
      coordinator, workflowTasks: jobs.metadata.agentWorkflows }, receipts: structuredClone(receipts) };
  }
  async function stopOwnedBroker() {
    let timer;
    try { await Promise.race([(async () => { if (broker.child.exitCode === null && broker.child.signalCode === null) broker.child.kill('SIGTERM'); await broker.exited; if (broker.errors) throw Error(broker.errors); })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned broker shutdown unconfirmed; fixture preserved')), 15000); })]); }
    finally { clearTimeout(timer); }
  }
  let initial;
  async function persist() {
    await writeFile(join(outputDirectory, 'observer.json'), JSON.stringify(await inspect(), null, 2), { mode: 0o600 });
  }
  async function grade() {
    const after = await inspect();
    const report = { ...gradeHostBrowser(initial, after, scenario), candidateRevision: manifest.candidateRevision,
      attempt: ++gradeNumber, capturedAt: new Date().toISOString(), evidence: after };
    await writeFile(join(outputDirectory, 'grades', `${String(gradeNumber).padStart(4, '0')}.json`), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    return report;
  }
  async function close() {
    if (stopped) return;
    // Persist before cleanup; failure to establish broker shutdown keeps installed files.
    await persist();
    await stopOwnedBroker();
    await writeFile(join(outputDirectory, 'shutdown.json'), JSON.stringify({ confirmed: true, brokerPid: broker.child.pid }), { mode: 0o600 });
    stopped = true;
    if (server) await new Promise((res, rej) => server.close(error => error ? rej(error) : res()));
    await state.cleanup();
  }
  let manifest;
  try {
    await cp(new URL('../../skills/', import.meta.url), join(state.plugin, 'skills'), { recursive: true });
    await prepareInstalledCampaign(state);
    const child = spawn(process.execPath, [join(state.plugin, 'apps/companion/command.mjs'), 'workflow', 'attempt', 'serve', '--root', state.root, '--native-lock', state.nativeLock], { cwd: state.plugin, env: { PATH: '', HOME: join(state.directory, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
    broker = { child, errors: '', exited: new Promise((res, rej) => { child.once('error', rej); child.once('close', res); }) };
    child.stdout.resume(); child.stderr.on('data', bytes => { broker.errors += bytes; });
    let ready = false;
    for (let tries = 0; tries < 100; tries++) {
      if ((await readFile(join(state.root, '.job-apply-attempt.pid'), 'utf8').catch(() => '')).trim() === String(child.pid)) { ready = true; break; }
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Owned attempt broker exited before ready');
      await new Promise(res => setTimeout(res, 20));
    }
    if (!ready) throw Error('Owned attempt broker did not become ready');
    // An ordinary read-only handshake clears the broker's initial idle timer.
    // Do this before publishing the manifest; skill reading may take longer than 10s.
    await state.call('workflow', ['attempt', 'context'], undefined, ['--job-id', 'job']);
    initial = await inspect();
    await writeFile(join(outputDirectory, 'initial.json'), JSON.stringify(initial, null, 2), { flag: 'wx', mode: 0o600 });
    server = createServer(async (request, response) => {
      const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      try {
        if (request.method === 'GET' && request.url === '/') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(hostBrowserPage()); return;
        }
        if (request.method === 'POST' && request.url === '/events') {
          const event = await body(request);
          if (page.events.length >= 1000) throw Object.assign(Error('event_limit'), { status: 413 });
          if (event.kind === 'submit' && Object.keys(event).length === 1) page.submitAttempts++;
          else if (['input', 'change'].includes(event.kind) && Object.keys(event).length === 3 && Object.hasOwn(initialValues, event.field)
            && (event.field === 'remote' ? typeof event.value === 'boolean' : typeof event.value === 'string' && event.value.length <= 512)) {
            page.values[event.field] = event.value;
            const counts = page[event.kind === 'input' ? 'inputCounts' : 'changeCounts']; counts[event.field] = (counts[event.field] ?? 0) + 1;
          } else throw Object.assign(Error('invalid_event'), { status: 400 });
          page.events.push({ ...event, sequence: page.events.length + 1 }); await persist(); reply(200, { ok: true }); return;
        }
        if (request.headers.authorization !== `Bearer ${token}`) { reply(403, { error: 'forbidden' }); return; }
        if (request.method === 'POST' && request.url === '/inspect') { reply(200, await inspect()); return; }
        if (request.method === 'POST' && request.url === '/grade') { reply(200, await grade()); return; }
        if (request.method === 'POST' && request.url === '/checkpoint') {
          const input = await body(request);
          if (!['interruption', 'resume-observation'].includes(input.kind) || Object.keys(input).length !== 1) throw Object.assign(Error('invalid_checkpoint'), { status: 400 });
          receipts.push({ kind: input.kind, page: pageSnapshot(), canonical: (await inspect()).canonical }); await persist(); reply(200, { ok: true }); return;
        }
        if (request.method === 'POST' && request.url === '/command') {
          const input = await body(request);
          if (!['context', 'event', 'host-browser-context', 'host-browser-report'].includes(input.command)
            || !['report', 'replay', 'stale-rejection', 'canonical'].includes(input.kind)) throw Object.assign(Error('invalid_command'), { status: 400 });
          const beforePage = pageSnapshot(), beforeCanonical = (await inspect()).canonical;
          const result = await state.call('workflow', ['attempt', input.command], input.payload, input.command.endsWith('context') ? ['--job-id', 'job'] : [], { failure: true });
          receipts.push({ kind: input.kind, command: input.command, payload: input.payload, result, beforePage, afterPage: pageSnapshot(), beforeCanonical, afterCanonical: (await inspect()).canonical });
          await persist(); reply(200, result); return;
        }
        if (request.method === 'POST' && request.url === '/stop') {
          // Close owned broker before responding. HTTP socket closes after response.
          await persist(); await stopOwnedBroker();
          await writeFile(join(outputDirectory, 'shutdown.json'), JSON.stringify({ confirmed: true, brokerPid: broker.child.pid }), { mode: 0o600 });
          reply(200, { stopped: true, shutdownConfirmed: true });
          setImmediate(() => close().catch(error => process.stderr.write(error.message + '\n'))); return;
        }
        reply(404, { error: 'not_found' });
      } catch (error) {
        if (request.url === '/events') { page.rejectedEvents++; await persist(); }
        reply(error.status ?? 500, { error: error.message });
      }
    });
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    const url = `http://127.0.0.1:${server.address().port}/`;
    manifest = { schemaVersion: 1, scenario, url, token, outputDirectory, manifestPath: join(outputDirectory, 'manifest.json'),
      candidateRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      installed: { plugin: state.plugin, skills: join(state.plugin, 'skills'), root: state.root, nativeLock: state.nativeLock, launcher: join(state.plugin, 'apps/companion/command.mjs'), node: process.execPath },
      expectedValues, instructions: 'Use only the new loopback tab and native host browser tools. Acquire with existing authorized attempt event. Fill four labelled controls, preserve notes, never submit; save Needs Info using host-browser-report with resume_upload checklist because the required resume upload visibly remains pending owner action. Use command interface for durable receipt evidence. No automatic acquisition occurs.',
      scenarioObligations: scenario === 'uncertain-resume' ? ['checkpoint interruption after write before report', 'inspect current DOM and context', 'checkpoint resume-observation without extra write'] : scenario === 'stale-report' ? ['progress report', 'reject new-ID stale revision', 'exact replay without browser action', 'fresh Needs Info report'] : ['Needs Info handoff'] };
    await writeFile(manifest.manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    return { url, manifest, inspect, grade, close };
  } catch (error) {
    if (broker) await stopOwnedBroker();
    if (server) await new Promise(resolveClose => server.close(resolveClose));
    await state.cleanup(); throw error;
  }
}
