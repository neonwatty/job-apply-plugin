import { answerLifecycleCommands, runAnswerLifecycleCommand } from './native-answer-lifecycle.js';
import { accountOperationCommands, runAccountOperationCommand } from './native-account-operation.js';
import { resumeLifecycleCommands, runResumeLifecycleCommand } from './native-resume-lifecycle.js';
import { trashCommands, runTrashCommand } from './native-trash.js';
import { groupedApprovalCommands, runGroupedApprovalCommand } from './native-grouped-approvals.js';
import { taskIntakeCommands, runTaskIntakeCommand } from './native-task-intake.js';
import { legacyJobCommands, runLegacyJobCommand } from './native-legacy-jobs.js';
import { jobUpsertCommands, runJobUpsertCommand } from './native-job-upsert.js';
import { claimCommands, runClaimCommand } from './native-claims.js';
import { jobTransitionCommands, runJobTransitionCommand } from './native-job-transitions.js';
import { projectionCommands, runProjectionCommand } from './native-projections.js';
import { pendingAnswerCommands, runPendingAnswerCommand } from './native-pending-answers.js';
import { profileCommands, runProfileCommand } from "./native-profile.js";
import { answerCommands, runAnswerCommand } from "./native-answers.js";
import { extractionCommands, runExtractionCommand } from "./native-extractions.js";
import { nativeAutomationCommandFields, nativeAutomationCommandNames, runNativeAutomationCommand } from './native-automation-commands.js';
import { nativeStoreStateCommandFields, nativeStoreStateCommandNames, resumeInputWithoutPath, runNativeStoreStateCommand } from './native-store-state.js';
import { nativeStoreBootstrapCommands, runNativeStoreBootstrapCommand } from './native-store-bootstrap.js';
import { nativeAuthorityCommands, runNativeAuthorityCommand } from './native-authority.js';
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JobsService } from "../workspace-core/jobs.js";
import { NativeJobsRepository, initializeJobsFixture } from "../store/native-jobs.js";
import { fixtureError } from "../store/native-jobs-error.js";
import { loadPosixFlockProvider } from "../store/posix-flock.js";
import { parse, serialize, JobsError } from "../contracts/workspace/values.js";
import { ResumeService } from "../workspace-core/resumes.js";
import { NativeResumeFiles } from "../store/native-resume-files.js";
import { createNativeStoreBootstrap } from '../store/native-store-bootstrap.js';
import { withStoreBootstrapLock } from './native-store-bootstrap-lock.js';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';
function defaultStoreRoot(environment = process.env) {
    const configured = environment.JOB_APPLY_STORE_DIR;
    const expanded = configured === '~' || configured?.startsWith('~/')
        ? realpathSync(homedir()) + configured.slice(1) : configured;
    return expanded ? resolve(expanded) : join(realpathSync(homedir()), '.job-apply');
}
async function nativeLock(options) {
    const explicit = options.get('--native-lock');
    if (explicit)
        return explicit;
    const executable = fileURLToPath(import.meta.url);
    return resolvePackagedNativeLock(realpathSync(resolve(dirname(executable), '../..')));
}
const directCommandFields = {
    'fixture-init': [], 'job-create': ['--input', '--origin'], 'job-get': ['--id', '--include-trashed'],
    'job-list': ['--status', '--include-trashed', '--trashed-only'],
    'job-update': ['--id', '--input', '--expected-revision', '--origin'],
    'resume-import': ['--input', '--path'], 'resume-get': ['--id', '--include-trashed'],
    'resume-list': ['--include-trashed', '--trashed-only'], 'resume-update': ['--id', '--input', '--expected-revision'],
    'resume-replace': ['--id', '--path', '--expected-revision'], 'resume-adopt': ['--id', '--path', '--expected-revision'],
    'resume-set-default': ['--id', '--expected-revision'], 'resume-resolve': ['--id'], 'resume-check': ['--id'],
};
export const nativeJobsCommandFamilies = [
    { owner: 'account-operation', fields: accountOperationCommands }, { owner: 'answer-lifecycle', fields: answerLifecycleCommands },
    { owner: 'resume-lifecycle', fields: resumeLifecycleCommands }, { owner: 'trash', fields: trashCommands },
    { owner: 'grouped-approvals', fields: groupedApprovalCommands }, { owner: 'task-intake', fields: taskIntakeCommands },
    { owner: 'legacy-jobs', fields: legacyJobCommands }, { owner: 'job-upsert', fields: jobUpsertCommands },
    { owner: 'job-transition', fields: jobTransitionCommands }, { owner: 'projections', fields: projectionCommands },
    { owner: 'claims', fields: claimCommands }, { owner: 'pending-answers', fields: pendingAnswerCommands },
    { owner: 'profile', fields: profileCommands }, { owner: 'answers', fields: answerCommands },
    { owner: 'extractions', fields: extractionCommands },
    { owner: 'automation', fields: nativeAutomationCommandFields },
    { owner: 'store-state', fields: nativeStoreStateCommandFields },
    { owner: 'authority', fields: nativeAuthorityCommands },
    { owner: 'store-bootstrap', fields: nativeStoreBootstrapCommands }, { owner: 'direct', fields: directCommandFields },
];
export const nativeJobsCommandFields = {};
for (const family of nativeJobsCommandFamilies)
    for (const [command, fields] of Object.entries(family.fields)) {
        if (Object.hasOwn(nativeJobsCommandFields, command))
            throw new Error(`duplicate native Jobs command owner: ${command}`);
        nativeJobsCommandFields[command] = fields;
    }
export const storeRequiredOptions = {
    'profile-replace': ['--input', '--expected-revision', '--source'],
    'profile-patch': ['--input', '--expected-revision', '--source'],
    'fact-group-get': ['--id'],
    'fact-group-create': ['--input'],
    'fact-group-update': ['--id', '--input', '--expected-revision'],
    'fact-group-delete': ['--id', '--expected-revision'],
    'preferences-set': ['--input', '--expected-revision', '--source'],
    'answer-key': ['--question'],
    'answer-put': ['--input'],
    'answer-get': ['--key'],
    'answer-find': ['--question'],
    'answer-reveal': ['--key'],
    'answer-observe': ['--input'],
    'answer-review': ['--key', '--decision', '--expected-revision'],
    'answer-update': ['--key', '--input', '--expected-revision'],
    'answer-trash': ['--key', '--expected-revision'],
    'answer-restore': ['--key', '--expected-revision'],
    'answer-delete': ['--key', '--expected-revision'],
    'answer-merge': ['--winner-key', '--source-key', '--expected-winner-revision', '--expected-source-revision'],
    'answer-semantic-lookup': ['--input'],
    'answer-cleanup-approve': ['--input'],
    'job-create': ['--input'],
    'job-upsert-preview': ['--input', '--origin'],
    'job-upsert-commit': ['--input', '--origin', '--token'],
    'legacy-jobs-commit': ['--select', '--confirm'],
    'job-get': ['--id'],
    'job-preflight': ['--id'],
    'application-run-start': ['--resume-id', '--expected-resume-revision', '--expected-fact-revision', '--input'],
    'application-run-update': ['--run-id', '--expected-revision', '--input'],
    'application-run-complete': ['--run-id', '--expected-revision'],
    'job-update': ['--id', '--input', '--expected-revision'],
    'job-transition': ['--id', '--status', '--expected-revision'],
    'job-acquire': ['--id', '--owner', '--expected-revision'],
    'job-review-restart': ['--id', '--owner', '--expected-revision'],
    'claim-heartbeat': ['--id', '--token'],
    'claim-recover': ['--id', '--owner'],
    'claim-progress': ['--id', '--token', '--input'],
    'claim-handoff': ['--id', '--token', '--status', '--input', '--expected-revision'],
    'attention-approval-preview': ['--id', '--expected-job-revision', '--expected-session-revision', '--input'],
    'attention-approval-approve': ['--id', '--expected-job-revision', '--expected-session-revision', '--preview-token', '--input'],
    'job-trash': ['--id', '--expected-revision'],
    'job-restore': ['--id', '--expected-revision'],
    'job-delete': ['--id', '--expected-revision'],
    'resume-create': ['--input'],
    'resume-import': ['--input'],
    'resume-get': ['--id'],
    'resume-update': ['--id', '--input', '--expected-revision'],
    'resume-adopt': ['--id', '--expected-revision'],
    'resume-set-default': ['--id', '--expected-revision'],
    'resume-check': ['--id'],
    'resume-trash': ['--id', '--expected-revision'],
    'resume-restore': ['--id', '--expected-revision'],
    'resume-delete': ['--id', '--expected-revision'],
    'resume-extraction-request-create': ['--resume-id', '--expected-resume-revision'],
    'resume-extraction-request-get': ['--id'],
    'resume-extraction-request-cancel': ['--id', '--expected-revision'],
    'resume-extraction-request-fail': ['--id', '--reason', '--expected-revision'],
    'resume-extraction-request-retry': ['--id', '--expected-revision', '--expected-resume-revision'],
    'resume-extraction-request-complete': ['--id', '--input', '--expected-request-revision', '--expected-profile-revision'],
    'resume-extraction-request-complete-scoped': ['--id', '--input', '--expected-request-revision'],
    'resume-facts-get': ['--resume-id'],
    'resume-facts-draft': ['--resume-id', '--input', '--expected-resume-revision'],
    'resume-facts-confirm': ['--resume-id', '--expected-fact-revision', '--expected-content-revision'],
    'resume-proposal-create': ['--resume-id', '--expected-resume-revision', '--expected-profile-revision', '--input'],
    'resume-proposal-get': ['--id'],
    'resume-proposal-review': ['--id', '--expected-revision', '--expected-profile-revision', '--input'],
    'history-append': ['--input'],
    'replay-transition': ['--id', '--transition', '--ats'],
    'session-save': ['--id', '--input'],
    'session-load': ['--id'],
    'session-delete': ['--id'],
    'automation-settings-update': ['--input', '--expected-revision'],
    'automation-settings-copy-profile-email': ['--expected-profile-revision', '--expected-settings-revision'],
    'account-realm-resolve': ['--url'],
    'account-flow-classify': ['--url'],
    'employer-account-get': ['--realm-ref'],
    'employer-account-create': ['--url'],
    'employer-account-update': ['--realm-ref', '--input', '--expected-revision'],
    'employer-account-execute-synthetic': ['--input'],
    'trusted-fill-approve': ['--input'],
    'trusted-fill-status': ['--id'],
    'trusted-fill-evaluate': ['--input'],
    'trusted-fill-revoke': ['--id', '--expected-approval-revision'],
    'application-authority-set': ['--input', '--expected-revision'],
    'application-authority-revoke': ['--expected-revision'],
    'application-authority-evaluate': ['--input'],
    'application-authority-pause': ['--expected-revision'],
    'application-authority-resume': ['--expected-revision'],
    'application-authority-stop': ['--expected-revision'],
};
const booleanOptions = new Set([
    '--include-trashed', '--trashed-only', '--replace', '--remember-sensitive',
    '--all-review-statuses', '--summary-only', '--owner-confirmed',
    '--owner-confirmed-not-submitted', '--user-confirmed',
]);
function storeUsage(command) {
    const prefix = 'usage: job-apply-store [-h] [--root ROOT] [--legacy-profile LEGACY_PROFILE]';
    if (!command)
        return `${prefix} {${Object.keys(nativeJobsCommandFields).join(',')}}`;
    const options = nativeJobsCommandFields[command] ?? [];
    const required = new Set(storeRequiredOptions[command] ?? []);
    return `usage: job-apply-store ${command} [-h] ${options.map(option => {
        const label = booleanOptions.has(option) ? option : `${option} ${option.slice(2).toUpperCase().replaceAll('-', '_')}`;
        return required.has(option) ? label : `[${label}]`;
    }).join(' ')}`.trimEnd();
}
function storeHelp(command) {
    const options = command ? nativeJobsCommandFields[command] ?? [] : ['--root', '--legacy-profile'];
    return `${storeUsage(command)}\n\noptions:\n  -h, --help  show this help message and exit\n`
        + options.map(option => `  ${option}\n`).join('');
}
export async function runJobsCli(args, input) {
    const options = new Map();
    let command;
    let help = false;
    const selected = [];
    for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (key === '-h' || key === '--help') {
            help = true;
            continue;
        }
        if (!key.startsWith("--")) {
            if (command)
                throw new JobsError("unexpected CLI argument");
            command = key;
        }
        else {
            if (booleanOptions.has(key))
                options.set(key, "true");
            else {
                const value = args[++index];
                if (!value || value.startsWith("--"))
                    throw new JobsError("missing CLI option value");
                options.set(key, value);
                if (key === "--select")
                    selected.push(value);
            }
        }
    }
    if (help && (!command || Object.hasOwn(nativeJobsCommandFields, command)))
        return storeHelp(command).trimEnd();
    const allowed = nativeJobsCommandFields[command ?? ""];
    const delegated = nativeAutomationCommandNames.has(command ?? '') || nativeStoreStateCommandNames.has(command ?? '')
        || Object.hasOwn(nativeAuthorityCommands, command ?? '');
    if (!allowed || !delegated && [...options.keys()].some(key => !["--root", "--native-lock", "--legacy-profile", ...allowed].includes(key))) {
        throw new JobsError("unsupported native Jobs command or option");
    }
    const missing = (storeRequiredOptions[command] ?? []).filter(option => !options.has(option));
    if (missing.length)
        throw new JobsError(`${storeUsage(command)}\njob-apply-store ${command}: error: the following arguments are required: ${missing.join(', ')}`);
    const required = (key) => {
        const value = options.get(key);
        if (!value)
            throw new JobsError(`required option: ${key}`);
        return value;
    };
    const root = options.get("--root") ?? defaultStoreRoot();
    if (Object.hasOwn(nativeStoreBootstrapCommands, command)) {
        if ([...options.keys()].some(key => !['--root', '--native-lock', '--legacy-profile'].includes(key))) {
            throw new JobsError('unsupported native Store bootstrap command or option');
        }
        const provider = command === 'init' ? loadPosixFlockProvider(await nativeLock(options)) : undefined;
        const service = createNativeStoreBootstrap(root, options.get('--legacy-profile'), process.env, undefined, provider ? { locked: operation => withStoreBootstrapLock(root, provider, operation) } : {});
        return serialize(await runNativeStoreBootstrapCommand(command, service));
    }
    if (command === "fixture-init") {
        await initializeJobsFixture(root);
        return '{"initialized":true}';
    }
    const repository = new NativeJobsRepository(root, loadPosixFlockProvider(await nativeLock(options)));
    const service = new JobsService(repository);
    const resumes = new ResumeService(repository);
    const payload = async () => {
        const file = required("--input");
        // Extraction candidates permit 256 KiB after normalization. Allow JSON
        // escaping and formatting overhead while keeping stdin bounded.
        // Bulk upsert accepts the same input domain through stdin and files, as Python does.
        const limit = (Object.hasOwn(jobUpsertCommands, command) || Object.hasOwn(taskIntakeCommands, command)) ? Infinity
            : ["resume-proposal-create", "resume-extraction-request-complete", "resume-extraction-request-complete-scoped", "resume-facts-draft"].includes(command) ? 2 * 1024 * 1024 : 65536;
        return parse(file === "-" ? await input(limit) : await readFile(file, "utf8"));
    };
    const leafArgs = [...options.entries()].filter(([key]) => !['--root', '--native-lock', '--legacy-profile'].includes(key))
        .flatMap(([key, value]) => value === 'true' ? [key] : [key, value]);
    const readInput = async (path) => parse(path === '-' ? await input(Infinity) : await readFile(path, 'utf8'));
    if (nativeAutomationCommandNames.has(command)) {
        return serialize((await runNativeAutomationCommand(command, leafArgs, { repository, readInput })));
    }
    if (nativeStoreStateCommandNames.has(command)) {
        return serialize((await runNativeStoreStateCommand(command, leafArgs, {
            repository, readInput, readResumePath: path => new NativeResumeFiles(root).readPath(path),
        })));
    }
    if (Object.hasOwn(nativeAuthorityCommands, command)) {
        return serialize((await runNativeAuthorityCommand(command, leafArgs, { repository, readInput })));
    }
    if (Object.hasOwn(accountOperationCommands, command))
        return serialize(await runAccountOperationCommand(command, repository));
    if (Object.hasOwn(answerLifecycleCommands, command))
        return serialize(await runAnswerLifecycleCommand(command, repository, options));
    if (Object.hasOwn(resumeLifecycleCommands, command))
        return serialize(await runResumeLifecycleCommand(command, repository, options));
    if (Object.hasOwn(trashCommands, command))
        return serialize(await runTrashCommand(command, repository, options));
    if (Object.hasOwn(groupedApprovalCommands, command))
        return serialize(await runGroupedApprovalCommand(command, repository, options, payload));
    if (Object.hasOwn(taskIntakeCommands, command))
        return serialize(await runTaskIntakeCommand(repository, options, payload));
    if (Object.hasOwn(legacyJobCommands, command))
        return serialize(await runLegacyJobCommand(command, repository, options, selected));
    if (Object.hasOwn(jobUpsertCommands, command))
        return serialize(await runJobUpsertCommand(command, repository, options, payload));
    if (Object.hasOwn(jobTransitionCommands, command))
        return serialize(await runJobTransitionCommand(repository, options));
    if (Object.hasOwn(projectionCommands, command))
        return serialize(await runProjectionCommand(command, repository, options));
    if (Object.hasOwn(claimCommands, command))
        return serialize(await runClaimCommand(command, repository, options, payload));
    if (Object.hasOwn(pendingAnswerCommands, command))
        return serialize(await runPendingAnswerCommand(command, repository, options));
    if (Object.hasOwn(profileCommands, command))
        return serialize(await runProfileCommand(command, repository, options, payload));
    if (Object.hasOwn(answerCommands, command))
        return serialize(await runAnswerCommand(command, repository, options, payload));
    if (Object.hasOwn(extractionCommands, command))
        return serialize(await runExtractionCommand(command, repository, options, payload));
    if (command === "resume-import") {
        const value = await payload();
        const selectedPath = options.get("--path");
        const { metadata, path } = selectedPath === undefined
            ? resumeInputWithoutPath(value)
            : { metadata: value, path: selectedPath };
        const content = await new NativeResumeFiles(root).readPath(path);
        return serialize(await resumes.import(metadata, basename(path), content, true));
    }
    if (command === "resume-get")
        return serialize(await resumes.get(required("--id"), options.has("--include-trashed")));
    if (command === "resume-list")
        return serialize(await resumes.list(options.has("--include-trashed"), options.has("--trashed-only")));
    if (command === "resume-resolve")
        return serialize(await resumes.resolve(options.get("--id")));
    if (command === "resume-check")
        return serialize(await resumes.check(required("--id")));
    if (command === "job-create")
        return serialize(await service.create(await payload(), options.get("--origin")));
    if (command === "job-get")
        return serialize(await service.get(required("--id"), options.has("--include-trashed")));
    if (command === "job-list")
        return serialize(await service.list({
            ...(options.has("--status") ? { status: options.get("--status") } : {}),
            includeTrashed: options.has("--include-trashed"), trashedOnly: options.has("--trashed-only"),
        }));
    const revision = required("--expected-revision");
    if (!/^[0-9]+$/.test(revision) || BigInt(revision) < 1n)
        throw new JobsError("expected revision must be a positive integer");
    if (command === "resume-update")
        return serialize(await resumes.update(required("--id"), await payload(), BigInt(revision)));
    if (command === "resume-set-default")
        return serialize(await resumes.setDefault(required("--id"), BigInt(revision)));
    if (command === "resume-replace" || command === "resume-adopt") {
        const path = required("--path"), content = await new NativeResumeFiles(root).readPath(path);
        return serialize(await resumes.replace(required("--id"), basename(path), content, BigInt(revision), command === "resume-adopt", true));
    }
    return serialize(await service.update(required("--id"), await payload(), BigInt(revision), options.get("--origin")));
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
    try {
        const result = await runJobsCli(process.argv.slice(2), async (limit = 65536) => {
            const chunks = [];
            let size = 0;
            for await (const chunk of process.stdin) {
                size += chunk.length;
                if (size > limit)
                    throw new JobsError(`input exceeds ${limit / 1024} KiB`);
                chunks.push(Buffer.from(chunk));
            }
            return Buffer.concat(chunks).toString("utf8");
        });
        process.stdout.write(result + "\n");
    }
    catch (error) {
        process.stderr.write(fixtureError(error) + "\n");
        process.exitCode = 2;
    }
}
