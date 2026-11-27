import { ReplayError } from './contracts.js';
const jobs = {
    'greenhouse-demo': { employer: 'Synthetic Greenhouse employer', role: 'Synthetic Greenhouse application' },
    'sample-ml-engineer': { employer: 'Fictional Ocotillo Labs', role: 'ML Engineer' },
    'sample-forward-deployed-engineer': { employer: 'Fictional Juniper Systems', role: 'Forward Deployed Engineer' },
};
export const defaultSubmissionJob = 'greenhouse-demo';
export function submissionJobs() {
    return Object.keys(jobs).map(submissionJob);
}
export function submissionJob(value = defaultSubmissionJob) {
    if (typeof value !== 'string' || !Object.hasOwn(jobs, value))
        throw new ReplayError('unsupported synthetic job');
    return { jobId: value, ...jobs[value] };
}
