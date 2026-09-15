import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, fstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { once } from "node:events";
import { parseWriterOptions, resolveWriterRoute } from "./writer-route.mjs";

const require = createRequire(import.meta.url);
const app = dirname(fileURLToPath(import.meta.url));
const children = new Set();
const externalProcessOwner = process.env.COMPANION_PROCESS_OWNER === "process-group-v1";
const explicitWriter = process.argv.includes('--writer') || process.argv.includes('--native-jobs-fixture');
if (externalProcessOwner && !fstatSync(3).isFile()) throw new Error('Companion process owner lease is unavailable');
let stopping = false;
function stopChild(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  try {
    if (externalProcessOwner) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) stopChild(child, "SIGTERM");
  await Promise.race([
    Promise.all([...children].map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : once(child, "exit").catch(() => {}))),
    new Promise(done => setTimeout(done, 3000)),
  ]);
  for (const child of children) stopChild(child, "SIGKILL");
  process.exitCode = code;
}
function owned(command, argv, env = process.env) {
  if (stopping) throw new Error("Companion startup cancelled");
  const child = spawn(command, argv, {
    cwd: app, env, detached: !externalProcessOwner,
    stdio: ["ignore", "pipe", "pipe", externalProcessOwner ? 3 : "ignore"],
  });
  children.add(child);
  child.on("error", () => { console.error("Companion child failed to start"); void shutdown(1); });
  child.on("exit", () => { if (!stopping) { console.error("Companion service stopped"); void shutdown(1); } });
  // Drain without logging private paths, tokens, or API values.
  child.stderr.on("data", () => {});
  return child;
}
async function choosePort(port) {
  const socket = createServer();
  socket.listen(port, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  await new Promise((done, reject) => socket.close(error => error ? reject(error) : done()));
  return address.port;
}
async function upstreamBoot(child) {
  return new Promise((done, reject) => {
    let text = "";
    const timer = setTimeout(() => finish(new Error("Workspace startup timed out")), 30000);
    function finish(error, value) {
      clearTimeout(timer); child.stdout.off("data", onData); child.off("exit", onExit); child.off("error", onExit);
      if (error) reject(error); else done(value);
    }
    function onExit() { finish(new Error("Workspace startup failed")); }
    function onData(bytes) {
      text += bytes.toString();
      if (text.length > 16384) return finish(new Error("Invalid workspace startup response"));
      if (!text.includes("\n")) return;
      try {
        const value = JSON.parse(text.split("\n")[0]);
        const url = new URL(value.url);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || value.origin !== url.origin) throw new Error();
        const token = new URLSearchParams(url.hash.slice(1)).get("token");
        if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error();
        finish(null, { upstream: url.origin, token });
      } catch { finish(new Error("Invalid workspace startup response")); }
    }
    child.stdout.on("data", onData); child.once("exit", onExit); child.once("error", onExit);
  });
}
async function launchInner() {
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown(0));
try {
  const options = parseWriterOptions(process.argv.slice(2), app);
  const route = await resolveWriterRoute(options);
  const port = await choosePort(options.port), origin = `http://127.0.0.1:${port}`;
  const writer = owned(route.command, route.argv);
  const { upstream, token } = await upstreamBoot(writer);
  writer.stdout.on("data", () => {});
  const standalone = join(app, ".next/standalone/apps/companion/server.js");
  if (!options.dev && !existsSync(standalone)) throw new Error("Build the Companion before starting it");
  const command = options.dev ? [require.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)] : [standalone];
  const next = owned(process.execPath, command, { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port),
    COMPANION_ORIGIN: origin, COMPANION_PYTHON_ORIGIN: upstream, COMPANION_TOKEN: token });
  next.stdout.on("data", () => {});
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(origin + "/api/boot", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for owned Next process to bind. */ }
    await new Promise(done => setTimeout(done, 200));
  }
  if (!ready) throw new Error("Companion startup failed");
  console.log(JSON.stringify({ url: `${origin}/#token=${token}`, origin, host: "127.0.0.1", port }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Companion startup failed");
  await shutdown(1);
}
}
async function launchSupervisor() {
  const supervisor = spawn(process.execPath, [join(app, 'supervise.mjs'), ...process.argv.slice(2)], {
    cwd: app, env: process.env, stdio: 'inherit', detached: false,
  });
  await once(supervisor, 'exit'); process.exitCode = supervisor.exitCode ?? 1;
}
if (!externalProcessOwner && !explicitWriter) await launchSupervisor();
else await launchInner();
