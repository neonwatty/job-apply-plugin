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

function prefixStream(stream, prefix, write) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) write(`${prefix}${line}\n`);
  });
  stream.on("end", () => {
    if (pending) write(`${prefix}${pending}\n`);
  });
}

export function runStreaming(executable, args, options = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status, code, signal = null) => {
      if (settled) return;
      settled = true;
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
    prefixStream(child.stdout, prefix, options.stdout ?? process.stdout.write.bind(process.stdout));
    prefixStream(child.stderr, prefix, options.stderr ?? process.stderr.write.bind(process.stderr));
    child.on("error", (error) => {
      (options.stderr ?? process.stderr.write.bind(process.stderr))(
        `${prefix}${error.message}\n`,
      );
      finish("failed", 1);
    });
    child.on("close", (code, signal) => finish(code === 0 ? "passed" : "failed", code ?? 1, signal));
  });
}
