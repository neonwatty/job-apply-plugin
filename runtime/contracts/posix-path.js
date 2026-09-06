import { lstat, readlink, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
export class PathLoopError extends Error {
    constructor() {
        super("Symlink loop during path resolution");
        this.name = "RuntimeError";
    }
}
export function validatePathProfile(profile) {
    if (!["3.12", "3.13", "3.14"].includes(profile)) {
        throw new RangeError("Unsupported Python path profile");
    }
}
/** Python PurePosixPath construction, retaining parent components and // anchor. */
export function constructPosixPath(base, child) {
    const raw = child.startsWith("/") || !base ? child : `${base}${base.endsWith("/") ? "" : "/"}${child}`;
    const anchor = raw.startsWith("//") && !raw.startsWith("///") ? "//" : raw.startsWith("/") ? "/" : "";
    const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
    return anchor + parts.join("/") || ".";
}
export function posixParent(path) {
    const normalized = constructPosixPath("", path);
    if (normalized === "/" || normalized === "//" || normalized === ".")
        return normalized;
    const separator = normalized.lastIndexOf("/");
    if (separator < 0)
        return ".";
    if (separator === 0)
        return "/";
    if (separator === 1 && normalized.startsWith("//"))
        return "//";
    return normalized.slice(0, separator);
}
function nativePath(path) {
    if (path.includes("\0")) {
        const error = new Error("embedded null byte");
        error.name = "ValueError";
        throw error;
    }
    if (Buffer.from(path, "utf8").toString("utf8") !== path) {
        throw new Error("Non-scalar POSIX paths require an unimplemented byte-path adapter");
    }
    return path;
}
const nativeIO = {
    lstat: (path) => lstat(nativePath(path)),
    stat: (path) => stat(nativePath(path)),
    async readlink(path) {
        const bytes = await readlink(nativePath(path), { encoding: "buffer" });
        try {
            return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        }
        catch {
            throw new Error("Non-UTF-8 link targets require an unimplemented byte-path adapter");
        }
    },
    cwd: () => process.cwd(),
};
function isOSFailure(error) {
    return error instanceof Error && "errno" in error && typeof error.errno === "number";
}
/** Non-strict parent resolution; missing/non-directory components remain lexical. */
export async function resolvePosixPath(path, profile, io = nativeIO) {
    validatePathProfile(profile);
    if (io === nativeIO && process.platform === "win32") {
        throw new Error("Native Windows path resolution is not supported by this inert POSIX adapter");
    }
    const seen = new Map();
    async function walk(initial, remainder) {
        let current = remainder.startsWith("/") ? "/" : initial;
        const parts = remainder.split("/");
        for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index];
            if (!part || part === ".")
                continue;
            if (part === "..") {
                current = current.slice(0, current.lastIndexOf("/")) || "/";
                continue;
            }
            const candidate = `${current === "/" ? "" : current}/${part}`;
            let isLink;
            try {
                isLink = (await io.lstat(candidate)).isSymbolicLink();
            }
            catch (error) {
                if (!isOSFailure(error))
                    throw error;
                current = candidate;
                continue;
            }
            if (!isLink) {
                current = candidate;
                continue;
            }
            const prior = seen.get(candidate);
            if (prior === null) {
                if (profile === "3.12") {
                    return { path: `${candidate}/${parts.slice(index + 1).join("/")}`, unresolved: true };
                }
                current = candidate;
                continue;
            }
            if (prior !== undefined) {
                current = prior;
                continue;
            }
            let target;
            try {
                target = await io.readlink(candidate);
            }
            catch (error) {
                if (profile === "3.12" || !isOSFailure(error))
                    throw error;
                current = candidate;
                continue;
            }
            seen.set(candidate, null);
            const resolved = await walk(current, target);
            current = resolved.path;
            if (resolved.unresolved) {
                return { path: `${current}/${parts.slice(index + 1).join("/")}`, unresolved: true };
            }
            seen.set(candidate, current);
        }
        return { path: current, unresolved: false };
    }
    const resolved = await walk(path.startsWith("/") ? "/" : io.cwd(), path);
    const normalized = [];
    for (const part of resolved.path.split("/")) {
        if (part === "..")
            normalized.pop();
        else if (part && part !== ".")
            normalized.push(part);
    }
    const result = `/${normalized.join("/")}`;
    if (profile === "3.12") {
        try {
            await io.stat(result);
        }
        catch (error) {
            if (!isOSFailure(error))
                throw error;
            if (error.code === "ELOOP")
                throw new PathLoopError();
        }
    }
    return result;
}
