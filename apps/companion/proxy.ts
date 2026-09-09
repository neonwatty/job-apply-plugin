import { NextRequest, NextResponse } from "next/server";
import { localConfig } from "./server/config";
import { legacyAssets } from "./server/assets";
import { forward } from "./server/forward";

export function proxy(request: NextRequest) {
  let origin: string;
  try { origin = localConfig().origin; }
  catch { return new NextResponse("Workspace launcher configuration is required", { status: 503 }); }
  if (request.headers.get("host") !== new URL(origin).host) {
    return NextResponse.json({ error: { code: "host_rejected", message: "request host is not the workspace" } }, { status: 403 });
  }
  if (request.nextUrl.pathname === "/legacy") {
    return NextResponse.redirect(new URL("/legacy/", origin), 307);
  }
  const path = request.nextUrl.pathname;
  if (path.startsWith("/api/")) return forward(request, "api");
  if (path.startsWith("/legacy/") || (path !== "/" && legacyAssets.has(path))) {
    return forward(request, "asset");
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const development = process.env.NODE_ENV === "development";
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ""}; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  const headers = new Headers(request.headers);
  headers.delete("x-middleware-subrequest");
  headers.set("Content-Security-Policy", csp);
  headers.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  return response;
}
export const config = { matcher: "/:path*" };
