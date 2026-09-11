import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixDirectoryProvider } from '../runtime/store/posix-directory.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { LegacyJobsService } from '../runtime/workspace-core/legacy-jobs.js';
import { discoverLegacyJobs } from '../runtime/store/legacy-job-discovery.js';
import { serialize } from '../runtime/contracts/workspace/values.js';
export const now='2026-09-10T12:00:00Z';
export const reportRoot='.claude-job-searches';
export const report=`# Synthetic search
### 1. Engineer — Fixture Corp (Score: 90)
- **URL**: https://example.invalid/jobs/one?utm_source=synthetic
- **Location**: Remote
- **Salary**: 100
### 2. Other Engineer — Fixture Corp
- **Apply**: https://example.invalid/jobs/two
### Unsupported heading
- **URL**: https://example.invalid/unsupported
### 4. Duplicate field — Fixture
- **URL**: https://example.invalid/a
- **url**: https://example.invalid/b
### 5. Missing URL — Fixture
- **Description**: No URL
### 6. Ambiguous URL — Fixture
- **URL**: https://example.invalid/a
- **Apply**: https://example.invalid/b
`;
export const plain=value=>JSON.parse(serialize(value));
export async function snapshot(root) {
  try {return await readFile(join(root,'jobs.json'),'utf8');}
  catch(error) {if(error.code==='ENOENT') return null;throw error;}
}
export async function setup(fixture,name) {
  const base=join(await realpath(fixture.root),name),home=join(base,'home'),root=join(base,'native'),pythonRoot=join(base,'python');
  await mkdir(join(home,reportRoot),{recursive:true});
  await writeFile(join(home,reportRoot,'search-2026-09-10.md'),report);
  await writeFile(join(home,reportRoot,'ignored.md'),'### unrelated');
  await initializeJobsFixture(root);
  await cp(root,pythonRoot,{recursive:true});
  const repository=new NativeJobsRepository(root,loadPosixFlockProvider(fixture.receipt.artifact));
  const service=new LegacyJobsService(repository,()=>discoverLegacyJobs(home,loadPosixDirectoryProvider(fixture.receipt.artifact)),()=>now);
  return {base,home,root,pythonRoot,repository,service};
}
export function oracle(fixture,op,selected=[],token) {
  return JSON.parse(execFileSync('python3',['tools/contracts/legacy-jobs/reference.py'],{
    input:JSON.stringify({root:fixture.pythonRoot,home:fixture.home,now,op,selected,token}),encoding:'utf8',maxBuffer:1024*1024,
  }));
}
export async function native(fixture,op,selected=[],token) {
  try {return {value:plain(await (op==='preview'?fixture.service.preview(selected):fixture.service.commit(selected,token)))};}
  catch(error) {return {error:error.message};}
}
