import { parsePythonPointJsonBytes } from '../contracts/raw-json/point-parser.js';
import { get, int, object, string, JobsError } from '../contracts/workspace/values.js';

export const nativeFixtureMarkerName = '.native-jobs-fixture';
export const nativeCloneMarkerName = '.native-store-clone';
export const nativeFixtureMarker = '{"mode":"native-jobs-fixture","version":12}\n';
export const nativeStoreRequiredEntries = [
  'automation-settings.json', 'employer-accounts.json', 'account-operation-journal.json',
  'trusted-fill.json', '.store.lock', 'jobs.json', 'profile.json', 'resumes.json',
  'fact-groups.json', 'answers.json', 'resume-operation.json', 'resume-files',
  'resume-extractions.json', 'resume-extraction-requests.json',
  'resume-extraction-journal.json', 'sessions', 'applications.jsonl',
  'coordinator.json', 'coordinator-journal.json',
] as const;
export const nativeStoreAllowedEntries = new Set([
  ...nativeStoreRequiredEntries, nativeFixtureMarkerName, nativeCloneMarkerName,
]);

export function nativeCloneTrees(bytes: Buffer): { sourceTree: string; candidateTree: string } {
  let marker;
  try {
    marker = object(parsePythonPointJsonBytes(bytes, { diagnosticProfile: '3.12', intMaxStrDigits: 4300 }), 'clone marker');
  } catch { throw new JobsError('native Store clone marker is invalid'); }
  const sourceTree = string(get(marker, 'sourceTree'));
  const candidateTree = string(get(marker, 'candidateTree'));
  if (marker.size !== 4 || string(get(marker, 'mode')) !== 'canonical-store-clone'
    || int(get(marker, 'version')) !== 2n || !/^sha256:[0-9a-f]{64}$/.test(sourceTree ?? '')
    || !/^sha256:[0-9a-f]{64}$/.test(candidateTree ?? '')) {
    throw new JobsError('native Store clone marker is invalid');
  }
  return { sourceTree: sourceTree!, candidateTree: candidateTree! };
}

export function validateNativeStoreMarker(name: string, bytes: Buffer): 'fixture' | 'clone' {
  if (name === nativeFixtureMarkerName) {
    if (bytes.toString('utf8') === nativeFixtureMarker) return 'fixture';
    throw new JobsError('native Store is not an explicitly initialized synthetic fixture');
  }
  if (name !== nativeCloneMarkerName) throw new JobsError('native Store ownership marker is invalid');
  nativeCloneTrees(bytes);
  return 'clone';
}
