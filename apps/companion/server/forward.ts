import { localConfig, validToken, type LocalConfig } from "./config";
import { permittedApi } from "./routes";
import { legacyAssets } from "./assets";

const MAX_BODY = 64 * 1024;
const MAX_UPLOAD = 4 * Math.ceil(10 * 1024 * 1024 / 3) + MAX_BODY;
const MAX_RESPONSE = 32 * 1024 * 1024;
export function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
export async function bounded(stream: ReadableStream<Uint8Array> | null, limit: number, timeoutMs = 30_000): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Body read timed out"));
      void reader.cancel().catch(() => {});
    }, timeoutMs);
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), timeout]);
      if (item.done) break;
      size += item.value.length;
      if (size > limit) throw new RangeError("Body exceeds limit");
      parts.push(item.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timer!); reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export async function forward(request: Request, kind: "api" | "asset",
  config: LocalConfig = localConfig(), fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("host") !== new URL(config.origin).host) {
    return failure(403, "host_rejected", "request host is not the workspace");
  }
  if (["OPTIONS", "PUT", "DELETE"].includes(request.method)) {
    return failure(405, "method_rejected", request.method === "OPTIONS"
      ? "cross-origin preflight is not supported" : "method not allowed");
  }
  if (url.search || url.hash) {
    return failure(404, "not_found", "route not found");
  }
  try { decodeURIComponent(url.pathname); }
  catch { return failure(400, "request_error", "request path is invalid"); }
  const path = kind === "asset" && url.pathname.startsWith("/legacy")
    ? url.pathname.slice(7) || "/" : url.pathname;
  const mutation = request.method !== "GET" && request.method !== "HEAD";
  if (kind === "api") {
    if (!validToken(request.headers.get("authorization"), config.token)) {
      return failure(401, "token_rejected", "workspace token is missing or invalid");
    }
    if (mutation && request.headers.get("origin") !== config.origin) {
      return failure(403, "origin_rejected", "request origin is not the workspace");
    }
    if (!permittedApi(request.method, path)) return failure(404, "not_found", "route not found");
  } else if (mutation || !legacyAssets.has(path)) {
    return failure(404, "not_found", "route not found");
  }
  const headers = new Headers();
  if (kind === "api") headers.set("Authorization", `Bearer ${config.token}`);
  let body: Uint8Array | undefined;
  if (mutation) {
    if (request.headers.get("content-type") !== "application/json") {
      return failure(415, "request_error", "Content-Type must be application/json");
    }
    const limit = path === "/api/resumes/import" || /^\/api\/resumes\/[^/]+\/(replace|adopt)$/.test(path)
      ? MAX_UPLOAD : MAX_BODY;
    const length = request.headers.get("content-length");
    if (length === null || !/^\d+$/.test(length)) return failure(411, "request_error", "a valid Content-Length is required");
    if (Number(length) > limit) return failure(413, "request_error", "request body is too large");
    try { body = await bounded(request.body, limit); }
    catch (error) {
      return error instanceof RangeError
        ? failure(413, "request_error", "request body is too large")
        : failure(408, "request_error", "request body read failed or timed out");
    }
    if (body.length !== Number(length)) return failure(400, "request_error", "request body length differs");
    headers.set("Content-Type", "application/json");
    headers.set("Origin", config.upstream);
  }
  try {
    const response = await fetchImpl(config.upstream + path, {
      method: request.method, headers, ...(body ? { body: Buffer.from(body) } : {}),
      redirect: "manual", cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("Unexpected redirect");
    const bytes = await bounded(response.body, MAX_RESPONSE);
    const outgoing = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
    for (const name of ["Content-Type", "Content-Disposition", "Content-Security-Policy"]) {
      const value = response.headers.get(name); if (value) outgoing.set(name, value);
    }
    return new Response(request.method === "HEAD" ? null : bytes, { status: response.status, headers: outgoing });
  } catch { return failure(502, "upstream_unavailable", "workspace service is unavailable"); }
}
