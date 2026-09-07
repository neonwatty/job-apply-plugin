const categories = {
    EACCES: "PermissionError", EPERM: "PermissionError",
    EEXIST: "FileExistsError", ENOENT: "FileNotFoundError",
    EISDIR: "IsADirectoryError", ENOTDIR: "NotADirectoryError",
    EINTR: "InterruptedError", EAGAIN: "BlockingIOError", EWOULDBLOCK: "BlockingIOError",
    EINPROGRESS: "BlockingIOError", EALREADY: "BlockingIOError",
    EPIPE: "BrokenPipeError", ESHUTDOWN: "BrokenPipeError",
    ECONNABORTED: "ConnectionAbortedError", ECONNREFUSED: "ConnectionRefusedError",
    ECONNRESET: "ConnectionResetError", ESRCH: "ProcessLookupError", ETIMEDOUT: "TimeoutError",
};
/** Preserve native diagnostics and identity while exposing Python's OSError category. */
export function pythonFilesystemError(error) {
    if (error instanceof Error && error.name === "Error" && "errno" in error
        && typeof error.errno === "number" && "code" in error && typeof error.code === "string") {
        error.name = Object.hasOwn(categories, error.code) ? categories[error.code] : "OSError";
    }
    return error;
}
/** Use only around native filesystem operations, not arbitrary application errors. */
export async function withPythonFilesystemErrors(operation) {
    try {
        return await operation;
    }
    catch (error) {
        throw pythonFilesystemError(error);
    }
}
