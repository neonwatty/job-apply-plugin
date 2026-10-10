import { NativeWorkflowArchive } from './native-workflow-archive.js';
import { browserOperationsMetadataKey, decodeBrowserOperationLedger } from '../contracts/workspace/browser-operations.js';
import { decodeWorkflowLedger, emptyWorkflowLedger, workflowMetadataKey } from '../contracts/workspace/workflow-tasks.js';
import { get, has, object } from '../contracts/workspace/values.js';
export async function validateWorkflowJobsArchive(root, jobs) {
    const metadata = object(get(jobs, 'metadata'), 'metadata');
    // Keep unrelated job validation behind each domain's existing lifecycle guards.
    if (has(metadata, browserOperationsMetadataKey))
        decodeBrowserOperationLedger(get(metadata, browserOperationsMetadataKey));
    const value = get(metadata, workflowMetadataKey);
    await new NativeWorkflowArchive(root).validate(value === null ? emptyWorkflowLedger() : decodeWorkflowLedger(value));
}
/** Validate every referenced segment before recovery can change any canonical document. */
export async function validateWorkflowRecovery(root, read) {
    const jobs = await read('jobs');
    if (jobs)
        await validateWorkflowJobsArchive(root, jobs);
    const coordinator = await read('coordinator-journal');
    const claim = coordinator && get(coordinator, 'operation');
    if (claim) {
        const workflow = get(object(claim, 'operation'), 'workflow');
        if (workflow !== null)
            await new NativeWorkflowArchive(root).validate(decodeWorkflowLedger(get(object(workflow, 'workflow'), 'after')));
    }
    const extraction = await read('resume-extraction-journal');
    if (extraction)
        await validateExtractionWorkflowArchive(root, extraction);
}
export async function validateExtractionWorkflowArchive(root, journal) {
    const operation = get(journal, 'operation');
    if (operation === null)
        return;
    const jobs = get(object(operation, 'operation'), 'jobsDocument');
    if (jobs !== null)
        await validateWorkflowJobsArchive(root, object(jobs, 'jobs'));
}
