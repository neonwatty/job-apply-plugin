import { iterPersistedJson } from "../contracts/persisted-json.js";
import { constructPosixPath, posixParent } from "../contracts/posix-path.js";
import { createNativeAtomicWriteIO, ensurePrivateDirectory, fsyncDirectory, isFilesystemError } from "./private-filesystem.js";
function withContext(error, previous) {
    if (error instanceof Error && previous !== undefined && error !== previous && error.cause === undefined) {
        error.cause = previous;
    }
    return error;
}
/** Atomic document replacement; failures after rename do not roll back installed bytes. */
export async function atomicWriteJson(path, payload, options, io = createNativeAtomicWriteIO(options.pathProfile)) {
    path = constructPosixPath("", path);
    const parent = posixParent(path);
    await ensurePrivateDirectory(parent, io);
    let temporaryPath;
    let failure;
    try {
        const name = path === "/" || path === "//" || path === "." ? "" : path.slice(path.lastIndexOf("/") + 1);
        const temporary = await io.createTemporary({ directory: parent, prefix: `.${name}.`, suffix: ".tmp" });
        temporaryPath = temporary.path;
        let writeFailure;
        try {
            for (const chunk of iterPersistedJson(payload, options))
                await temporary.write(chunk);
            await temporary.write("\n");
            await temporary.flush();
            await temporary.sync();
        }
        catch (error) {
            writeFailure = error;
            throw error;
        }
        finally {
            try {
                await temporary.close();
            }
            catch (error) {
                throw withContext(error, writeFailure);
            }
        }
        await io.chmod(temporaryPath, 0o600);
        await io.replace(temporaryPath, path);
        temporaryPath = undefined;
        await io.chmod(path, 0o600);
        await fsyncDirectory(parent, io);
    }
    catch (error) {
        failure = error;
        throw error;
    }
    finally {
        if (temporaryPath !== undefined) {
            try {
                await io.unlink(temporaryPath);
            }
            catch (error) {
                if (!isFilesystemError(error) || error.code !== "ENOENT")
                    throw withContext(error, failure);
            }
        }
    }
}
