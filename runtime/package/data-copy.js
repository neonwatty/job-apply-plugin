import { validatePathProfile } from "../contracts/posix-path.js";
class DataCopyError extends Error {
    constructor(name, message) {
        super(message);
        this.name = name;
    }
}
function contextual(error, previous, explicit = false) {
    if (error instanceof Error && previous !== undefined && error !== previous) {
        // Python breaks a previous implicit chain before linking a reused exception.
        const visited = new Set();
        let cursor = previous;
        while (cursor instanceof Error && !visited.has(cursor)) {
            visited.add(cursor);
            const prior = cursor;
            if (prior.pythonContext === error) {
                delete prior.pythonContext;
                break;
            }
            cursor = prior.pythonContext;
        }
        error.pythonContext = previous;
        if (explicit) {
            error.cause = previous;
            error.pythonSuppressContext = true;
        }
    }
    return error;
}
/** Actual copyfileobj protocol: a single write per read, without short-write retry. */
export async function copyFileObjects(source, target, length) {
    if (!Number.isSafeInteger(length) || length <= 0)
        throw new RangeError("Copy buffer length must be a positive safe integer");
    for (;;) {
        const bytes = await source.read(length);
        if (bytes.length === 0)
            return;
        await target.write(bytes);
    }
}
/** Inert copyfile control flow. The caller explicitly supplies every IO operation. */
export async function copyFileData(source, target, options) {
    validatePathProfile(options.profile);
    if (options.platform !== "darwin")
        throw new RangeError("Only the observed macOS data-copy protocol is implemented");
    const io = options.io;
    let same = false;
    try {
        same = await io.sameFile(source, target);
    }
    catch (error) {
        if (!io.isOSError(error))
            throw error;
    }
    if (same)
        throw new DataCopyError("SameFileError", `${io.pathRepr(source)} and ${io.pathRepr(target)} are the same file`);
    for (const path of [source, target]) {
        let metadata;
        try {
            metadata = await io.stat(path);
        }
        catch (error) {
            if (!io.isOSError(error))
                throw error;
        }
        if (metadata?.isFIFO())
            throw new DataCopyError("SpecialFileError", `\`${path}\` is a named pipe`);
    }
    if (!options.followSymlinks && await io.isLink(source)) {
        await io.symlink(await io.readLink(source), target);
        return target;
    }
    const reader = await io.openSource(source);
    let outerFailure;
    try {
        try {
            const writer = await io.openTarget(target);
            let innerFailure;
            try {
                const result = io.accelerate === undefined ? "give-up" : await io.accelerate(reader, writer);
                if (result !== "copied" && result !== "give-up")
                    throw new TypeError("Invalid data-copy accelerator result");
                if (result === "give-up")
                    await copyFileObjects(reader, writer, options.profile === "3.14" ? 262144 : 65536);
            }
            catch (error) {
                innerFailure = error;
                throw error;
            }
            finally {
                try {
                    await writer.close();
                }
                catch (error) {
                    throw contextual(error, innerFailure);
                }
            }
        }
        catch (error) {
            if (io.isDirectoryError(error)) {
                let exists;
                try {
                    exists = await io.exists(target);
                }
                catch (inspectionError) {
                    throw contextual(inspectionError, error);
                }
                if (!exists)
                    throw contextual(new DataCopyError("FileNotFoundError", `Directory does not exist: ${target}`), error, true);
            }
            throw error;
        }
    }
    catch (error) {
        outerFailure = error;
        throw error;
    }
    finally {
        try {
            await reader.close();
        }
        catch (error) {
            throw contextual(error, outerFailure);
        }
    }
    return target;
}
