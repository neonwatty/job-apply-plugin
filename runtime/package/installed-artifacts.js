import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { filesystemDecode } from "../contracts/posix-path-bytes.js";
import { constructPosixPath } from "../contracts/posix-path.js";
import { withPythonFilesystemErrors } from "../contracts/filesystem-error.js";
import { artifactBytes, artifactIsSymlink, artifactOSError, artifactRoot, ArtifactVerificationError, checkedArtifactPath, regularArtifactFile } from "./artifact-paths.js";
export const FIXED_CRITICAL_FILES = [
    ".codex-plugin/plugin.json",
    "scripts/job-apply-store.py",
    "scripts/job-apply-task.py",
    "scripts/job-apply-attempt.py",
    "scripts/job-apply-workspace.py",
    "skills/answer-memory/SKILL.md",
    "skills/job-apply/SKILL.md",
];
export const CRITICAL_TREES = [
    "runtime", "scripts/job_apply_store", "scripts/job_apply_workspace", "workspace",
];
function pythonStringOrder(left, right) {
    const first = [...left];
    const second = [...right];
    for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
        const difference = first[index].codePointAt(0) - second[index].codePointAt(0);
        if (difference)
            return difference;
    }
    return first.length - second.length;
}
async function walkArtifacts(root, relative, profile, paths) {
    const directory = constructPosixPath(root, relative);
    let entries;
    try {
        entries = await withPythonFilesystemErrors(readdir(artifactBytes(directory), { encoding: "buffer", withFileTypes: true }));
    }
    catch (error) {
        // Python os.walk has no onerror callback here, so directory scan OSErrors
        // are suppressed. Inventory completeness policy must not silently change.
        if (artifactOSError(error))
            return;
        throw error;
    }
    const directories = [];
    const files = [];
    for (const entry of entries) {
        const name = filesystemDecode(entry.name);
        // os.walk uses DirEntry's cached type for ordinary entries. An unnecessary
        // stat would change classification when the parent has no search permission.
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
            try {
                isDirectory = (await withPythonFilesystemErrors(stat(artifactBytes(constructPosixPath(directory, name))))).isDirectory();
            }
            catch (error) {
                if (!artifactOSError(error))
                    throw error;
            }
        }
        (isDirectory ? directories : files).push(name);
    }
    for (const name of directories) {
        const child = `${relative}/${name}`;
        if (await artifactIsSymlink(constructPosixPath(root, child), profile)) {
            throw new ArtifactVerificationError(`critical package tree contains a symlink: ${child}`);
        }
    }
    for (const name of files) {
        const child = `${relative}/${name}`;
        if (await artifactIsSymlink(constructPosixPath(root, child), profile)) {
            throw new ArtifactVerificationError(`critical package tree contains a symlink: ${child}`);
        }
        await regularArtifactFile(root, child);
        paths.add(child);
    }
    for (const name of directories) {
        const child = `${relative}/${name}`;
        // os.walk checks os.path.islink again before descending without following
        // links; its suppression policy is the broad os.path policy on all profiles.
        if (!await artifactIsSymlink(constructPosixPath(root, child), "3.14")) {
            await walkArtifacts(root, child, profile, paths);
        }
    }
}
/** Inventory only critical files; unrelated files and empty directories are ignored. */
export async function criticalPaths(root, profile) {
    root = await artifactRoot(root, profile);
    const paths = new Set(FIXED_CRITICAL_FILES);
    for (const relative of FIXED_CRITICAL_FILES)
        await regularArtifactFile(root, relative);
    for (const relative of CRITICAL_TREES) {
        const tree = await checkedArtifactPath(root, relative);
        let metadata;
        try {
            metadata = await withPythonFilesystemErrors(lstat(artifactBytes(tree)));
        }
        catch (error) {
            if (!artifactOSError(error))
                throw error;
            throw new ArtifactVerificationError(`critical package tree is missing: ${relative}`);
        }
        if (!metadata.isDirectory()) {
            throw new ArtifactVerificationError(`critical package tree is not a directory: ${relative}`);
        }
        await walkArtifacts(root, relative, profile, paths);
    }
    return [...paths].sort(pythonStringOrder);
}
/** Exact critical inventory and bytes; file modes are deliberately not compared. */
export async function assertCriticalBytes(installed, source, options) {
    installed = await artifactRoot(installed, options.profile);
    source = await artifactRoot(source, options.profile);
    const expected = await criticalPaths(source, options.profile);
    const actual = await criticalPaths(installed, options.profile);
    if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
        throw new ArtifactVerificationError(`${options.label} critical package inventory differs`);
    }
    for (const relative of expected) {
        const installedPath = await regularArtifactFile(installed, relative);
        const installedBytes = await withPythonFilesystemErrors(readFile(artifactBytes(installedPath)));
        const sourceBytes = await withPythonFilesystemErrors(readFile(artifactBytes(constructPosixPath(source, relative))));
        if (!installedBytes.equals(sourceBytes)) {
            throw new ArtifactVerificationError(`${options.label} bytes differ for ${relative}`);
        }
    }
}
