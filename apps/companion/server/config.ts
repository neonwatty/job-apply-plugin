import { timingSafeEqual } from "node:crypto";

export interface LocalConfig { origin: string; upstream: string; token: string }
export function localConfig(env = process.env): LocalConfig {
  const origin = env.COMPANION_ORIGIN ?? "";
  const upstream = env.COMPANION_PYTHON_ORIGIN ?? "";
  const token = env.COMPANION_TOKEN ?? "";
  for (const value of [origin, upstream]) {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.origin !== value) throw new Error("Invalid local service configuration");
  }
  if (origin === upstream || !/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error("Invalid local service configuration");
  }
  return { origin, upstream, token };
}
export function validToken(value: string | null, token: string): boolean {
  const actual = Buffer.from(value ?? ""), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
