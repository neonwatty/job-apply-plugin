import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

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

export function createLinePrefixer(label, write, { finalNewline = true } = {}) {
  let decoder = new StringDecoder("utf8");
  let openLine = false;
  function text(value) {
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== "\n") continue;
      const content = value.slice(start, index);
      if (content) {
        write(`${openLine ? "" : `${label} `}${content}`);
        openLine = true;
      }
      write(openLine ? "\n" : `${label}\n`);
      openLine = false;
      start = index + 1;
    }
    const tail = value.slice(start);
    if (tail) {
      write(`${openLine ? "" : `${label} `}${tail}`);
      openLine = true;
    }
  }
  return {
    write(chunk) { text(decoder.write(chunk)); },
    flush() {
      text(decoder.end());
      decoder = new StringDecoder("utf8");
      if (openLine && finalNewline) write("\n");
      openLine = false;
    },
  };
}

function prefixStream(stream, label, write, maxBytes, overflow) {
  const formatter = createLinePrefixer(label, write);
  let acceptedBytes = 0;
  let truncated = false;
  let reportedTruncation = false;
  const flush = () => {
    formatter.flush();
    if (truncated && !reportedTruncation) {
      reportedTruncation = true;
      write(`${label} [output truncated after ${maxBytes} bytes]\n`);
    }
  };
  stream.on("data", (chunk) => {
    const remaining = Math.max(0, maxBytes - acceptedBytes);
    const accepted = chunk.subarray(0, remaining);
    acceptedBytes += accepted.length;
    const firstOverflow = !truncated && accepted.length < chunk.length;
    truncated ||= accepted.length < chunk.length;
    formatter.write(accepted);
    if (firstOverflow) overflow();
  });
  stream.on("end", flush);
  return flush;
}

export function runStreaming(executable, args, options = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    let reason;
    let forceKill;
    let forceResolution;
    let timeout;
    let flushOutput = () => {};
    const finish = (status, code, signal = null) => {
      if (settled) return;
      settled = true;
      flushOutput();
      clearTimeout(timeout);
      clearTimeout(forceKill);
      clearTimeout(forceResolution);
      resolve({
        status: reason ? "failed" : status,
        exitCode: reason ? (reason === "timeout" ? 124 : 130) : code,
        signal: reason ?? signal,
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
    function stop(cause) {
      if (settled || reason) return;
      reason = cause;
      clearTimeout(timeout);
      if (cause === "timeout") {
        flushOutput();
        (options.stderr ?? process.stderr.write.bind(process.stderr))(
          `${prefix}timed out after ${options.timeoutMs}ms\n`,
        );
      }
      forceKill = setTimeout(() => {
        terminateTree(child, "SIGKILL");
        clearTimeout(forceResolution);
        forceResolution = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish("failed", 1);
        }, 100);
      }, 1000);
      forceResolution = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish("failed", 1);
      }, 2000);
      terminateTree(child, "SIGTERM");
    }
    const overflow = () => stop("output-limit");
    const flushStdout = prefixStream(child.stdout, `[${options.label}]`, options.stdout ?? process.stdout.write.bind(process.stdout), maxBytes, overflow);
    const flushStderr = prefixStream(child.stderr, `[${options.label}]`, options.stderr ?? process.stderr.write.bind(process.stderr), maxBytes, overflow);
    flushOutput = () => { flushStdout(); flushStderr(); };
    if (options.timeoutMs) timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    child.on("error", (error) => {
      (options.stderr ?? process.stderr.write.bind(process.stderr))(
        `${prefix}${error.message}\n`,
      );
      finish("failed", 1);
    });
    child.on("close", (code, signal) => {
      if (reason && processTreeAlive(child)) return;
      finish(code === 0 ? "passed" : "failed", code ?? 1, signal);
    });
  });
}
