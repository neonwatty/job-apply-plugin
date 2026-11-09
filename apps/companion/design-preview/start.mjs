// Synthetic data only. Each launch allocates a new private temporary Store.
import { mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnOwnedCompanion } from '../../../tests_js/workspace_next_process_support.mjs';
import { fileURLToPath } from 'node:url';
import { buildNativeLock } from '../../../tools/build-native-lock.mjs';
import { initializeJobsFixture, NativeJobsRepository } from '../../../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../../../runtime/store/posix-flock.js';
import { JobsService } from '../../../runtime/workspace-core/jobs.js';
import { ResumeService } from '../../../runtime/workspace-core/resumes.js';
import { ExtractionService } from '../../../runtime/workspace-core/extraction.js';
import { fromJSON } from '../../../runtime/contracts/workspace/values.js';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'focus-queue-preview-')));
const root = join(temporary, 'store');
const receipt = await buildNativeLock({ outputDirectory: join(temporary, 'addon') });
await initializeJobsFixture(root);
if (!process.argv.includes('--empty')) {
  const repository = new NativeJobsRepository(root, loadPosixFlockProvider(receipt.artifact));
  const jobs = new JobsService(repository);
  const examples = [
    ['northstar','Northstar Studio','Senior Product Designer','awaiting_review'],
    ['fieldwork','Fieldwork','Design Engineer','needs_info'],
    ['common-ground','Common Ground','Staff Frontend Engineer','in_progress'],
    ['tidal','Tidal Research','UX Engineer','saved'],
    ['canopy','Canopy Labs','Senior Software Engineer','saved'],
  ];
  for (const [id,company,role] of examples) await jobs.create(fromJSON({id,company,role,url:`https://example.invalid/${id}`,location:'Remote',ats:'greenhouse'}));
  // Fixture-only lifecycle snapshots, written before the server owns the Store.
  const document = JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8'));
  for (const [id,,,status] of examples) document.jobs[id].status=status;
  await writeFile(join(root, 'jobs.json'), JSON.stringify(document), {mode:0o600});
  const profile = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8'));
  profile.profile = {name:'Morgan Sample',location:'Portland, Oregon',skills:['Product design','TypeScript','Accessibility']};
  await writeFile(join(root, 'profile.json'), JSON.stringify(profile), {mode:0o600});
  await new ResumeService(repository).import(fromJSON({id:'design-resume',label:'Product & engineering',default:true}), 'sample.txt', Buffer.from('Morgan Sample\nSynthetic preview resume\nProduct design and frontend engineering.'));
  await new ExtractionService(repository).createProposal('design-resume', fromJSON({name:'Morgan Sample', skills:['Product design','TypeScript','Accessibility','Design systems']}), 1n, 1n);
}
const portIndex=process.argv.indexOf('--port');
const port=portIndex<0?'4312':process.argv[portIndex+1];
const {child,stop}=await spawnOwnedCompanion(repo,root,
  ['--writer','native-fixture','--native-lock',receipt.artifact],
  {leaseArtifact:receipt.artifact,args:['--port',port]});
child.stdout.on('data', bytes=>process.stdout.write(bytes));
child.stderr.on('data', bytes=>process.stderr.write(bytes));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>void stop());
child.on('exit',code=>process.exit(code??0));
