import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { JobsService } from "../workspace-core/jobs.js";
import { jobsHttp, apiError } from "../workspace-core/jobs-http.js";
import { NativeJobsRepository } from "../store/native-jobs.js";
import { loadPosixFlockProvider } from "../store/posix-flock.js";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--root" || args[2] !== "--native-lock") {
    throw new Error("usage: native-jobs-server --root /synthetic/root --native-lock /artifact.node");
}
const repository = new NativeJobsRepository(args[1], loadPosixFlockProvider(args[3]));
const service = new JobsService(repository);
await service.list();
const token = randomBytes(32).toString("base64url");
let origin = "";
const server = createServer(async (request, response) => {
    const send = (result) => {
        response.writeHead(result.status, { "Content-Type": "application/json", "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff", "Connection": "close" });
        response.end(result.body);
    };
    const fail = (status, code, message) => send(apiError(status, code, message));
    try {
        if (request.headers.host !== new URL(origin).host)
            return fail(403, "host_rejected", "request host is not the workspace");
        const actual = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            return fail(401, "token_rejected", "workspace token is missing or invalid");
        if (!["GET", "POST", "PATCH"].includes(request.method))
            return fail(405, "method_rejected", "method not allowed");
        const path = request.url ?? "";
        if (!path.startsWith("/api/") || path.includes("?") || path.includes("#"))
            return fail(404, "not_found", "route not found");
        try {
            decodeURIComponent(path);
        }
        catch {
            return fail(400, "request_error", "request path is invalid");
        }
        let body = "";
        if (request.method !== "GET") {
            if (request.headers.origin !== origin)
                return fail(403, "origin_rejected", "request origin is not the workspace");
            if (request.headers["content-type"] !== "application/json")
                return fail(415, "request_error", "Content-Type must be application/json");
            const length = request.headers["content-length"];
            if (!length || !/^\d+$/.test(length))
                return fail(411, "request_error", "a valid Content-Length is required");
            if (Number(length) > 65536)
                return fail(413, "request_error", "request body is too large");
            request.setTimeout(30_000, () => request.destroy());
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 65536)
                    return fail(413, "request_error", "request body is too large");
                chunks.push(Buffer.from(chunk));
            }
            if (size !== Number(length))
                return fail(400, "request_error", "request body length differs");
            try {
                body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            }
            catch {
                return fail(400, "request_error", "body must be UTF-8 JSON");
            }
        }
        send(await jobsHttp(service, repository, request.method, path, body));
    }
    catch {
        fail(503, "store_unavailable", "native fixture service is unavailable");
    }
});
server.requestTimeout = 30_000;
server.headersTimeout = 30_000;
server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("native service did not bind");
    origin = `http://127.0.0.1:${address.port}`;
    process.stdout.write(JSON.stringify({ origin, url: `${origin}/#token=${token}` }) + "\n");
});
for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
        server.closeAllConnections();
        server.close();
    });
