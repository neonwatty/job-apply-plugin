import { spawn } from "node:child_process";

function terminateTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T", "/F"];
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") return false;
  }
  return true;
}

function processTreeAlive(child) {
  if (!child.pid || process.platform === "win32") return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export function runCapture(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      code: code ?? 1,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function prefixStream(stream, prefix, write, maxBytes) {
  let pending = "";
  let acceptedBytes = 0;
  let truncated = false;
  stream.on("data", (chunk) => {
    const remaining = Math.max(0, maxBytes - acceptedBytes);
    const accepted = chunk.subarray(0, remaining);
    acceptedBytes += accepted.length;
    truncated ||= accepted.length < chunk.length;
    pending += accepted.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) write(`${prefix}${line}\n`);
  });
  stream.on("end", () => {
    if (pending) write(`${prefix}${pending}\n`);
    if (truncated) write(`${prefix}[output truncated after ${maxBytes} bytes]\n`);
  });
}

export function runStreaming(executable, args, options = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let forceKill;
    let forceResolution;
    let timeout;
    const finish = (status, code, signal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      clearTimeout(forceResolution);
      resolve({
        status,
        exitCode: code,
        signal,
        durationMs: Math.round(performance.now() - started),
      });
    };
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const prefix = `[${options.label}] `;
    const maxBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    prefixStream(child.stdout, prefix, options.stdout ?? process.stdout.write.bind(process.stdout), maxBytes);
    prefixStream(child.stderr, prefix, options.stderr ?? process.stderr.write.bind(process.stderr), maxBytes);
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        (options.stderr ?? process.stderr.write.bind(process.stderr))(
          `${prefix}timed out after ${options.timeoutMs}ms\n`,
        );
        forceKill = setTimeout(() => {
          terminateTree(child, "SIGKILL");
          clearTimeout(forceResolution);
          forceResolution = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            finish("failed", 124, "timeout");
          }, 100);
        }, 1000);
        forceResolution = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish("failed", 124, "timeout");
        }, 2000);
        terminateTree(child, "SIGTERM");
      }, options.timeoutMs);
    }
    child.on("error", (error) => {
      (options.stderr ?? process.stderr.write.bind(process.stderr))(
        `${prefix}${error.message}\n`,
      );
      finish("failed", 1);
    });
    child.on("close", (code, signal) => {
      if (timedOut && processTreeAlive(child)) return;
      finish(
        !timedOut && code === 0 ? "passed" : "failed",
        timedOut ? 124 : code ?? 1,
        timedOut ? "timeout" : signal,
      );
    });
  });
}
