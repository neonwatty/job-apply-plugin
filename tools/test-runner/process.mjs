import { spawn } from "node:child_process";

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
    let timeout;
    const finish = (status, code, signal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
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
        forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
    child.on("error", (error) => {
      (options.stderr ?? process.stderr.write.bind(process.stderr))(
        `${prefix}${error.message}\n`,
      );
      finish("failed", 1);
    });
    child.on("close", (code, signal) => finish(
      !timedOut && code === 0 ? "passed" : "failed",
      timedOut ? 124 : code ?? 1,
      timedOut ? "timeout" : signal,
    ));
  });
}
