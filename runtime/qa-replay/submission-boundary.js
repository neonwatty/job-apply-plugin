import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialization } from '../final-action-policy/model.js';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';
import { withExclusiveFileLock } from '../store/exclusive-file-lock.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { expandRoot } from '../final-action-policy/repository.js';
import { canonical, readJson, ReplayError, runIdentifier } from './contracts.js';
export const submissionMode = 'submit_after_approval';
export const submissionFixture = 'greenhouse-single-page-2026-08-v1';
export const submissionScenario = 'greenhouse-complete-profile';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export const submissionFixturesRoot = join(packageRoot, 'qa/fixtures');
export const submissionScenariosRoot = join(packageRoot, 'qa/scenarios');
export const runsRoot = () => resolve(process.env.JOB_APPLY_QA_RUNS_ROOT ?? join(packageRoot, 'qa/runs'));
export async function labApprovalEnabled(root) {
    const path = join(root, 'lab-mode.json');
    try {
        await lstat(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    const value = await readJson(path, 'The lab approval setting is unavailable.');
    if (typeof value !== 'boolean')
        throw new ReplayError('The lab approval setting is invalid.');
    return value;
}
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const revision = (value) => `sha256:${digest(canonical(value))}`;
export const browserResumeFilename = 'synthetic-resume.pdf';
function within(path, root) {
    const rel = relative(root, path);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export async function requireIsolatedPath(path) {
    const defaultStore = join(await realpath(homedir()), '.job-apply');
    const configured = process.env.JOB_APPLY_STORE_DIR;
    const possibleStores = [defaultStore, ...(configured ? [resolve(expandRoot(configured))] : [])];
    for (const store of possibleStores) {
        const actual = await realpath(store).catch(() => store);
        if (within(path, store) || within(path, actual)) {
            throw new ReplayError('synthetic submission requires an isolated QA store');
        }
    }
}
export function requireLoopbackOrigin(origin) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin) || Number(origin.split(':').at(-1)) > 65535) {
        throw new ReplayError('synthetic submission requires an exact loopback destination');
    }
}
export async function requirePrivateDirectory(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()
        || await realpath(path) !== path) {
        throw new ReplayError('synthetic submission requires a private QA run');
    }
}
export async function requireSubmissionRun(root) {
    if (!runIdentifier.test(basename(root)))
        throw new ReplayError('invalid synthetic run identifier');
    await requirePrivateDirectory(root);
    await requireIsolatedPath(root);
    await requirePrivateDirectory(join(root, 'store'));
}
export async function submissionInputs(root, fixture) {
    if (fixture.id !== submissionFixture || fixture.platformFamily !== 'greenhouse') {
        throw new ReplayError('synthetic submission fixture is unsupported');
    }
    await requireSubmissionRun(root);
    const store = join(root, 'store');
    const fixturePath = join(root, 'fixture.json');
    const resumePath = join(root, browserResumeFilename);
    const approvedFixture = join(submissionFixturesRoot, submissionFixture, 'fixture.json');
    const approvedResume = join(submissionScenariosRoot, submissionScenario, browserResumeFilename);
    for (const path of [fixturePath, resumePath]) {
        if (!(await lstat(path)).isFile())
            throw new ReplayError('synthetic submission inputs have changed');
    }
    const [actualFixture, expectedFixture, actualResume, expectedResume, profile] = await Promise.all([
        readFile(fixturePath), readFile(approvedFixture), readFile(resumePath), readFile(approvedResume),
        readJson(join(store, 'profile.json'), 'synthetic submission profile is unavailable'),
    ]);
    if (!actualFixture.equals(expectedFixture) || !actualResume.equals(expectedResume)
        || canonical(JSON.parse(actualFixture.toString('utf8'))) !== canonical(fixture)) {
        throw new ReplayError('synthetic submission inputs have changed');
    }
    return { resumeDigest: digest(actualResume), inputsRevision: revision(profile) };
}
export function approvalRootFromFixture(fixturePath) {
    if (basename(fixturePath) !== 'fixture.json')
        throw new ReplayError('invalid synthetic fixture path');
    return dirname(fixturePath);
}
export async function submissionLockProvider() {
    return loadPosixFlockProvider(await resolvePackagedNativeLock(await realpath(packageRoot)));
}
export async function withSubmissionLifecycle(root, operation) {
    await requireSubmissionRun(root);
    return withQaLock(join(root, '.submission.lock'), operation);
}
export async function withQaLock(path, operation) {
    return withExclusiveFileLock(path, operation, {
        provider: await submissionLockProvider(), pathProfile: serialization.pathProfile,
    });
}
