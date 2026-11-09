import { validateAnswers } from '../contracts/workspace/answers.js';
import { validateCoordinator } from '../contracts/workspace/claims.js';
import { validateExtractionRequests } from '../contracts/workspace/extraction-requests.js';
import { validateJobsDocument } from '../contracts/workspace/jobs.js';
import { validateProfile } from '../contracts/workspace/profile.js';
import { validateResumeFacts } from '../contracts/workspace/resume-facts.js';
import type { Document } from '../contracts/workspace/values.js';
import { validateExtractionResumes } from './native-extraction-journal.js';
import { NativeResumeFiles } from './native-resume-files.js';

type Reader = (name: string) => Promise<Document>;

export async function nativePendingAnswerState(
  document: Reader, journal: Reader, sessions: () => Promise<Document[]>, root: string,
) {
  const [jobs, answers, profile, resumes, facts, requests, coordinator, sessionValues] = await Promise.all([
    document('jobs'), document('answers'), document('profile'), document('resumes'),
    document('resume-facts'), document('resume-extraction-requests'), journal('coordinator'), sessions(),
  ]);
  return {
    jobs: validateJobsDocument(jobs), answers: validateAnswers(answers), profile: validateProfile(profile),
    resumes: validateExtractionResumes(resumes), facts: validateResumeFacts(facts),
    requests: validateExtractionRequests(requests), coordinator: validateCoordinator(coordinator),
    sessions: sessionValues, files: new NativeResumeFiles(root),
  };
}
