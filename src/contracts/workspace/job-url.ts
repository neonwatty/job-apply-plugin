import { isIP } from "node:net";
import { JobsError } from "./values.js";

// Match Python str.strip rather than ECMAScript's BOM-inclusive trim.
export const strip = (value: string): string => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");

/** urllib identity: retain path, escapes and query; do not resolve dot segments or IDNA. */
export function normalizeJobUrl(input: string | null): string {
  if (input === null || !strip(input)) throw new JobsError("job URL must be a non-empty string");
  const value = strip(input).replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  const match = /^(https?):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/is.exec(value);
  if (!match) throw new JobsError("job URL must use HTTP or HTTPS");
  const scheme = match[1]!.toLowerCase(), authority = match[2]!;
  const normalized = authority.replace(/[@:#?]/g, "").normalize("NFKC");
  if (/[/?#@:]/.test(normalized)) throw new JobsError("job URL is invalid");
  let host: string, portText: string | undefined;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.includes("[") || hostPort.includes("]")) {
    const bracket = /^\[([^\]]+)\](?::(.*))?$/.exec(hostPort);
    if (!bracket || !(isIP(bracket[1]!) === 6 || /^v[\da-f]+\..+$/i.test(bracket[1]!))) {
      throw new JobsError("job URL is invalid");
    }
    host = bracket[1]!;
    portText = bracket[2];
  } else {
    const colon = hostPort.indexOf(":");
    host = colon < 0 ? hostPort : hostPort.slice(0, colon);
    portText = colon < 0 ? undefined : hostPort.slice(colon + 1);
  }
  if (portText && (!/^\d+$/.test(portText) || BigInt(portText) > 65535n)) {
    throw new JobsError("job URL is invalid");
  }
  if (!host) throw new JobsError("job URL must use HTTP or HTTPS");
  if (authority.includes("@")) throw new JobsError("job URL must not contain credentials");
  host = host.toLowerCase();
  if (host.includes(":")) host = `[${host}]`;
  const port = portText ? Number(portText) : null;
  const suffix = port === null || scheme === "http" && port === 80 || scheme === "https" && port === 443
    ? "" : `:${port}`;
  return `${scheme}://${host}${suffix}${match[3] || "/"}${match[4] ? `?${match[4]}` : ""}`;
}
