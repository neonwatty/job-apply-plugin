import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { RecorderError } from "./errors.mjs";

const BROKER_REQUEST_DEADLINE_MS = 1000;
const BROKER_EOF_GRACE_MS = 250;
const BROKER_TERMINATE_GRACE_MS = 1500;

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new RecorderError("operation canceled");
}

export function withDeadline(promise, timeoutMs, signal, onTimeout) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new RecorderError("operation canceled"));
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        finish(reject, new RecorderError("operation timed out"));
      }
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

export class BrokerClient {
  constructor(child, lines) {
    this.child = child;
    this.lines = lines;
    this.nextId = 1;
    this.pending = new Map();
    this.requestQueue = Promise.resolve();
    this.closed = false;
  }

  static async start(root) {
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const child = spawn("python3", ["-m", "qa.recorder_fs", "--root", root], {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout });
    let ready;
    try {
      ready = await withDeadline(new Promise((resolve, reject) => {
        lines.once("line", (line) => {
          try {
            const message = JSON.parse(line);
            if (message?.ready !== true || Object.keys(message).length !== 1) throw new Error();
            resolve();
          } catch {
            reject(new RecorderError("filesystem broker unavailable"));
          }
        });
        child.once("exit", () => reject(new RecorderError("filesystem broker unavailable")));
        child.once("error", () => reject(new RecorderError("filesystem broker unavailable")));
      }), 2000);
    } catch (error) {
      lines.close();
      child.kill("SIGTERM");
      throw error;
    }
    void ready;
    const client = new BrokerClient(child, lines);
    lines.on("line", (line) => client._handleLine(line));
    child.on("exit", () => client._failAll());
    child.on("error", () => client._failAll());
    return client;
  }

  _failAll() {
    this.closed = true;
    clearTimeout(this.terminationTimer);
    clearTimeout(this.killTimer);
    this.terminationTimer = undefined;
    this.killTimer = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new RecorderError("filesystem broker unavailable"));
    }
    this.pending.clear();
  }

  _failClosed() {
    this._failAll();
    this.child.stdin.destroy();
    if (this.child.exitCode === null && !this.terminationTimer) {
      this.terminationTimer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill("SIGTERM");
      }, BROKER_EOF_GRACE_MS);
      this.terminationTimer.unref?.();
      this.killTimer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill("SIGKILL");
      }, BROKER_EOF_GRACE_MS + BROKER_TERMINATE_GRACE_MS);
      this.killTimer.unref?.();
    }
  }

  _handleLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this._failClosed();
      return;
    }
    const pending = this.pending.get(response?.id);
    if (!pending) {
      this._failClosed();
      return;
    }
    this.pending.delete(response.id);
    if (response.ok === true && Object.hasOwn(response, "result")) {
      pending.resolve(response.result);
    } else {
      pending.reject(new RecorderError("filesystem operation rejected"));
    }
  }

  _requestNow(command, fields) {
    if (this.closed || this.child.exitCode !== null) {
      return Promise.reject(new RecorderError("filesystem broker unavailable"));
    }
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, command, ...fields })}\n`;
    const operation = withDeadline(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(new RecorderError("filesystem broker unavailable"));
        }
      });
    }), BROKER_REQUEST_DEADLINE_MS, undefined, () => this._failClosed());
    return operation.finally(() => this.pending.delete(id));
  }

  request(command, fields = {}) {
    if (this.closed || this.child.exitCode !== null) {
      return Promise.reject(new RecorderError("filesystem broker unavailable"));
    }
    const operation = this.requestQueue.then(() => this._requestNow(command, fields));
    this.requestQueue = operation.catch(() => {});
    return operation;
  }

  write(command, relative, data) {
    return this.request(command, {
      path: relative,
      data: Buffer.from(data).toString("base64"),
    });
  }

  writeJson(command, relative, value) {
    return this.write(command, relative, `${JSON.stringify(value)}\n`);
  }

  async close() {
    await this.requestQueue.catch(() => {});
    if (this.child.exitCode !== null) {
      this.lines.close();
      return;
    }
    this.closed = true;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    await withDeadline(new Promise((resolve) => {
      if (this.child.exitCode !== null) resolve();
      else this.child.once("exit", resolve);
    }), 2000).catch(() => {
      this.child.kill("SIGKILL");
    });
    this.lines.close();
  }
}
