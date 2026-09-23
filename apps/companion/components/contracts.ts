import { PythonObject } from '../../../src/contracts/python-object';
import { PythonText } from '../../../src/contracts/python-text';
import { integer, parse, serialize, text, type Value } from '../../../src/contracts/workspace/values';

const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
const minSafe = BigInt(Number.MIN_SAFE_INTEGER);

function plain(value: Value, exactInteger = false): unknown {
    if (value instanceof PythonText)
        return value.codePoints.map(point => String.fromCodePoint(point)).join('');
    if (value instanceof PythonObject) {
        const canonicalJob = ['id', 'url', 'status', 'revision'].every(key => value.has(text(key)));
        return Object.fromEntries(value.entries().map(([key, item]) => {
            const name = String(plain(key));
            return [name, plain(item, canonicalJob && name === 'revision')];
        }));
    }
    if (Array.isArray(value)) return value.map(item => plain(item));
    if (value !== null && typeof value === 'object' && 'kind' in value) {
        if (value.kind === 'int' && typeof value.value === 'bigint')
            return exactInteger && (value.value < minSafe || value.value > maxSafe) ? value.value : Number(value.value);
        return value.value;
    }
    return value;
}

function point(value: unknown, arrayItem = false): Value {
    if (value === undefined) {
        if (arrayItem) return null;
        throw Error('Undefined object fields must be omitted.');
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value);
    if (typeof value === 'bigint') return integer(value);
    if (typeof value === 'number') return parse(JSON.stringify(value));
    if (Array.isArray(value)) return value.map(item => point(item, true));
    if (typeof value === 'object') {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            throw Error('Request body must contain plain JSON values.');
        const result = new PythonObject<Value>();
        for (const [key, item] of Object.entries(value)) {
            if (item !== undefined) result.set(text(key), point(item));
        }
        return result;
    }
    throw Error('Request body must contain JSON values.');
}

export const parseJson = (raw: string): unknown => plain(parse(raw));
export const stringifyJson = (value: unknown): string => serialize(point(value));

export type RecordValue = {
    [key: string]: unknown;
};
export function object(value: unknown): value is RecordValue {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export const textFields = ['url', 'role', 'company', 'location', 'workplaceType', 'employmentType', 'compensation', 'notes', 'description'] as const;
export type TextField = typeof textFields[number];
export type JobFields = Record<TextField, string> & {
    resumeId: string | null;
    priority: number;
};
export type Job = RecordValue & {
    id: string;
    revision: bigint;
    status: string;
    url: string;
};
export type Resume = {
    id: string;
    label: string;
    default: boolean;
};
export type ResumeRecord = Resume & {
    storageKind?: 'managed';
    mediaType?: string;
    tags: string[];
    observedSize?: number;
    observedModifiedAt?: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
};
export type WorkspaceState = {
    jobs: Job[];
    resumes: Resume[];
    applicationRun: ApplicationRun | null;
};
export type ApplicationRun = {
    runId: string;
    revision: number;
    selection: { resumeId: string; factRevision: number };
    queueVersions: Array<{ revision: number; jobIds: string[] }>;
};
export type Boot = {
    status: 'ready';
    mode?: 'native-jobs-fixture' | 'native-store-clone';
} | {
    status: 'degraded';
    summary: string;
    guidance: string;
};
export type OverviewData = {
    setup: {
        hasProfileFacts: boolean;
        hasResume: boolean;
        factsWorkspace?: 'resumes';
    };
    counts: Record<'jobs' | 'readyJobs' | 'attentionJobs' | 'resumes' | 'answers', number>;
    nextAction: string;
    targetWorkspace: string;
};
function invalid(): never {
    throw Error('The workspace returned an invalid response.');
}
function revision(value: unknown): bigint {
    if (typeof value === 'bigint' && value > 0n) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
    return invalid();
}
export function job(value: unknown): Job {
    if (!object(value) || typeof value.id !== 'string' || typeof value.url !== 'string'
        || typeof value.status !== 'string')
        return invalid();
    const currentRevision = revision(value.revision);
    return {
        ...value, id: value.id, url: value.url, status: value.status, revision: currentRevision
    };
}
export function workspaceState(value: unknown): WorkspaceState {
    if (!object(value) || !Array.isArray(value.jobs) || !Array.isArray(value.resumes))
        return invalid();
    let applicationRun: ApplicationRun | null = null;
    if (value.applicationRun !== null && value.applicationRun !== undefined) {
        const run = value.applicationRun;
        if (!object(run) || typeof run.runId !== 'string' || typeof run.revision !== 'number'
            || !object(run.selection) || typeof run.selection.resumeId !== 'string'
            || typeof run.selection.factRevision !== 'number' || !Array.isArray(run.queueVersions)) return invalid();
        const queueVersions = run.queueVersions.map(version => {
            if (!object(version) || typeof version.revision !== 'number' || !Array.isArray(version.jobIds)
                || version.jobIds.some(id => typeof id !== 'string')) return invalid();
            return { revision: version.revision, jobIds: version.jobIds as string[] };
        });
        applicationRun = { runId: run.runId, revision: run.revision,
            selection: { resumeId: run.selection.resumeId, factRevision: run.selection.factRevision }, queueVersions };
    }
    return {
        jobs: value.jobs.map(job), resumes: value.resumes.map(value => {
            if (!object(value) || typeof value.id !== 'string')
                return invalid();
            return {
                id: value.id, label: typeof value.label === 'string' ? value.label : value.id, default: value.default === true
            };
        }), applicationRun
    };
}
export function resume(value: unknown): ResumeRecord {
    if (!object(value) || typeof value.id !== 'string' || typeof value.label !== 'string'
        || typeof value.default !== 'boolean' || typeof value.revision !== 'number'
        || !Number.isSafeInteger(value.revision) || value.revision < 1
        || value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string')) || typeof value.createdAt !== 'string'
        || typeof value.updatedAt !== 'string' || value.storageKind !== undefined && value.storageKind !== 'managed')
        return invalid();
    return { ...value, id: value.id, label: value.label, default: value.default,
        revision: value.revision, tags: value.tags === undefined ? [] : value.tags as string[], createdAt: value.createdAt,
        updatedAt: value.updatedAt, storageKind: value.storageKind } as ResumeRecord;
}
export function resumeList(value: unknown): ResumeRecord[] {
    if (!object(value) || !Array.isArray(value.resumes)) return invalid();
    return value.resumes.map(resume);
}
export function boot(value: unknown): Boot {
    if (!object(value))
        return invalid();
    if (value.status === 'ready')
        return {
            status: 'ready',
            ...(value.mode === 'native-jobs-fixture' || value.mode === 'native-store-clone'
                ? { mode: value.mode as 'native-jobs-fixture' | 'native-store-clone' } : {})
        };
    if (value.status === 'degraded' && typeof value.summary === 'string' && typeof value.guidance === 'string')
        return {
            status: 'degraded', summary: value.summary, guidance: value.guidance
        };
    return invalid();
}
export function overview(value: unknown): OverviewData {
    if (!object(value) || !object(value.setup) || !object(value.counts) || typeof value.nextAction !== 'string' || typeof value.targetWorkspace !== 'string')
        return invalid();
    const { setup, counts } = value;
    if (typeof setup.hasProfileFacts !== 'boolean' || typeof setup.hasResume !== 'boolean')
        return invalid();
    const count = (name: string) => {
        const n = counts[name];
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
            return invalid();
        return n;
    };
    return {
        setup: {
            hasProfileFacts: setup.hasProfileFacts, hasResume: setup.hasResume,
            ...(setup.factsWorkspace === 'resumes' ? { factsWorkspace: 'resumes' as const } : {})
        }, counts: {
            jobs: count('jobs'), readyJobs: count('readyJobs'), attentionJobs: count('attentionJobs'), resumes: count('resumes'), answers: count('answers')
        }, nextAction: value.nextAction, targetWorkspace: value.targetWorkspace
    };
}
