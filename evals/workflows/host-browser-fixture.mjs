import { createServer } from 'node:http';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installedFixture, durableSnapshot, readDocument } from '../../tests_js/workspace_installed_workflows_support.mjs';
import { prepareInstalledCampaign } from './scenarios.mjs';
import { hostBrowserPage, initialValues, expectedValues } from './host-browser-page.mjs';
import { immutableDigest, gradeHostBrowser, digest } from './host-browser-grade.mjs';
import { recoveryScenarios, ownedBrokerLifecycle, validateInjection, recoveryCheckpoint, reportNeedsObservation, gradeHostBrowserRecovery } from './host-browser-recovery.mjs';
const scenarios = ['controls-handoff', 'uncertain-resume', 'stale-report', ...recoveryScenarios];
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
  const lifecycle = ownedBrokerLifecycle(state);
  let broker, server, stopped = false, gradeNumber = 0, injecting = false, closing = false, closePromise;
  let pendingRequest = Promise.resolve();
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
  const stopOwnedBroker = () => lifecycle.close();
  let initial;
  async function persist() {
    await writeFile(join(outputDirectory, 'observer.json'), JSON.stringify(await inspect(), null, 2), { mode: 0o600 });
  }
  async function grade() {
    const after = await inspect();
    const report = { ...(recoveryScenarios.includes(scenario) ? gradeHostBrowserRecovery(initial, after, scenario) : gradeHostBrowser(initial, after, scenario)), candidateRevision: manifest.candidateRevision,
      attempt: ++gradeNumber, capturedAt: new Date().toISOString(), evidence: after };
    await writeFile(join(outputDirectory, 'grades', `${String(gradeNumber).padStart(4, '0')}.json`), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    return report;
  }
  function close() {
    if (stopped) return Promise.resolve();
    closing = true;
    closePromise ??= (async () => {
      // Drain in-flight injection through its receipt before stopping children or deleting Store files.
      await pendingRequest;
      await persist();
      await stopOwnedBroker();
      await writeFile(join(outputDirectory, 'shutdown.json'), JSON.stringify({ confirmed: true, brokerPid: broker.child.pid }), { mode: 0o600 });
      stopped = true;
      if (server) await new Promise((res, rej) => server.close(error => error ? rej(error) : res()));
      await state.cleanup();
    })();
    return closePromise;
  }
  let manifest;
  try {
    await cp(new URL('../../skills/', import.meta.url), join(state.plugin, 'skills'), { recursive: true });
    await prepareInstalledCampaign(state);
    broker = await lifecycle.start();
    initial = await inspect();
    await writeFile(join(outputDirectory, 'initial.json'), JSON.stringify(initial, null, 2), { flag: 'wx', mode: 0o600 });
    const handleRequest = async (request, response) => {
      const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      try {
        if (closing) { reply(409, { error: 'fixture_closing' }); return; }
        if (injecting) { reply(409, { error: 'recovery_in_progress' }); return; }
        if (request.method === 'GET' && request.url === '/') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(hostBrowserPage()); return;
        }
        if (request.method === 'POST' && request.url === '/events') {
          const event = await body(request);
          if (page.events.length >= 1000) throw Object.assign(Error('event_limit'), { status: 413 });
          if (event.kind === 'page-load' && Object.keys(event).length === 1) page.values = { ...initialValues };
          else if (event.kind === 'submit' && Object.keys(event).length === 1) page.submitAttempts++;
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
        if (request.method === 'POST' && request.url === '/inject') {
          const input = await body(request); validateInjection(input);
          injecting = true;
          const before = await inspect();
          const receipt = { ...input, sequence: receipts.length + 1, status: 'started', evidenceKind: 'fixture_owned_process',
            oldPid: broker.child.pid, beforePage: before.page, beforeCanonical: before.canonical,
            beforeDurableDigest: digest(await durableSnapshot(state.root)) };
          receipts.push(receipt);
          try {
            await persist();
            await lifecycle.stop(broker, input.signal);
            broker = await lifecycle.start();
            receipt.newPid = broker.child.pid; receipt.startupContext = broker.startupContext;
            receipt.status = 'completed';
          } catch (error) { receipt.status = 'failed'; receipt.error = error.message; }
          finally {
            broker = lifecycle.current;
            const after = await inspect();
            receipt.afterPage = after.page; receipt.afterCanonical = after.canonical;
            receipt.afterDurableDigest = digest(await durableSnapshot(state.root));
            injecting = false;
            await persist();
          }
          reply(receipt.status === 'completed' ? 200 : 500, receipt); return;
        }
        if (request.method === 'POST' && request.url === '/checkpoint') {
          const input = await body(request);
          const snapshot = { page: pageSnapshot(), canonical: (await inspect()).canonical };
          const receipt = input && ['interruption', 'resume-observation'].includes(input.kind) && Object.keys(input).length === 1
            ? { kind: input.kind, ...snapshot }
            : recoveryCheckpoint(input, receipts, snapshot, manifest.url);
          receipts.push(receipt); await persist(); reply(200, { ok: true, sequence: receipt.sequence }); return;
        }
        if (request.method === 'POST' && request.url === '/command') {
          const input = await body(request);
          if (!['context', 'event', 'host-browser-context', 'host-browser-report'].includes(input.command)
            || !['report', 'replay', 'stale-rejection', 'canonical'].includes(input.kind)) throw Object.assign(Error('invalid_command'), { status: 400 });
          const beforePage = pageSnapshot(), beforeCanonical = (await inspect()).canonical;
          const blocked = reportNeedsObservation(input, receipts, { page: beforePage });
          const result = blocked ? { ok: false, error: 'recovery_observation_required' } : await state.call('workflow', ['attempt', input.command], input.payload, input.command.endsWith('context') ? ['--job-id', 'job'] : [], { failure: true });
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
    };
    // Serialize fixture state transitions, including body parsing and broker replacement.
    server = createServer((request, response) => {
      if (closing) { response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'fixture_closing' })); return; }
      pendingRequest = pendingRequest.then(() => handleRequest(request, response)).catch(error => {
        response.destroy(error);
      });
    });
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    const url = `http://127.0.0.1:${server.address().port}/`;
    manifest = { schemaVersion: 1, scenario, url, token, outputDirectory, manifestPath: join(outputDirectory, 'manifest.json'),
      candidateRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      installed: { plugin: state.plugin, skills: join(state.plugin, 'skills'), root: state.root, nativeLock: state.nativeLock, launcher: join(state.plugin, 'apps/companion/command.mjs'), node: process.execPath },
      expectedValues, instructions: scenario === 'broker-restart' ? 'Use only the new loopback tab and native host tools. Acquire explicitly, fill four labelled controls preserving notes, capture host-browser-context progress input, then inject owned broker restart. Reobserve DOM and host-browser-context, record recovery-observation, and submit old progress report to demonstrate rejection. Stop safely with live claim; never force lease expiry or submit.' : 'Use only the new loopback tab and native host browser tools. Acquire with existing authorized attempt event. Fill four labelled controls, preserve notes, never submit; save Needs Info using host-browser-report with resume_upload checklist because the required resume upload visibly remains pending owner action. Use command interface for durable receipt evidence. No automatic acquisition occurs.',
      recoveryProtocol: recoveryScenarios.includes(scenario) ? { injection: { kind: 'broker-restart', signal: 'SIGKILL' }, lossCheckpointKinds: ['tab-closed', 'browser-tool-reconnect'], observationKind: 'recovery-observation', evidence: 'native_host_browser attestation; transcript required', tabClosureDraft: 'lost; page-load resets observer values; reconstruct after observation' } : undefined,
      scenarioObligations: scenario === 'broker-restart' ? ['real owned broker replacement', 'fresh context and DOM observation', 'old progress report rejected', 'blocked safely with unchanged live claim and page'] : ['tab-closed', 'browser-tool-reconnect'].includes(scenario) ? ['actual host fault transcript', 'loss checkpoint', 'fresh context and DOM recovery-observation', 'Needs Info handoff'] : scenario === 'uncertain-resume' ? ['checkpoint interruption after write before report', 'inspect current DOM and context', 'checkpoint resume-observation without extra write'] : scenario === 'stale-report' ? ['progress report', 'reject new-ID stale revision', 'exact replay without browser action', 'fresh Needs Info report'] : ['Needs Info handoff'] };
    await writeFile(manifest.manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    return { url, manifest, inspect, grade, close };
  } catch (error) {
    if (broker) await stopOwnedBroker();
    if (server) await new Promise(resolveClose => server.close(resolveClose));
    await state.cleanup(); throw error;
  }
}
