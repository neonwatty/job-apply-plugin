import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { once } from "node:events";

const require = createRequire(import.meta.url);
const app = dirname(fileURLToPath(import.meta.url));
const options = { root: undefined, pluginRoot: resolve(app, "../.."), port: 0, dev: false, nativeLock: undefined };
const args = process.argv.slice(2);
while (args.length) {
  const key = args.shift();
  if (key === "--dev") options.dev = true;
  else if (["--root", "--plugin-root", "--port", "--native-jobs-fixture"].includes(key)) {
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error("Missing launcher option value");
    if (key === "--root") options.root = resolve(value);
    if (key === "--plugin-root") options.pluginRoot = resolve(value);
    if (key === "--port") options.port = Number(value);
    if (key === "--native-jobs-fixture") options.nativeLock = resolve(value);
  } else throw new Error("Unknown launcher option");
}
if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid port");
const children = new Set();
let stopping = false;
function stopChild(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
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
  const child = spawn(command, argv, { cwd: app, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
async function pythonBoot(child) {
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
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown(0));
try {
  const port = await choosePort(options.port), origin = `http://127.0.0.1:${port}`;
  if (options.nativeLock && !options.root) throw new Error("Native Jobs requires an explicit synthetic root");
  const script = join(options.pluginRoot, options.nativeLock
    ? "runtime/cli/native-jobs-server.js" : "scripts/job-apply-workspace.py");
  if (!existsSync(script)) throw new Error("Workspace runtime is unavailable");
  const argv = options.nativeLock
    ? [script, "--root", options.root, "--native-lock", options.nativeLock]
    : [script, "--no-open", "--json", ...(options.root ? ["--root", options.root] : [])];
  const python = owned(options.nativeLock ? process.execPath : "python3", argv);
  const { upstream, token } = await pythonBoot(python);
  python.stdout.on("data", () => {});
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
