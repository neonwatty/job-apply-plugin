import { jobUpsertCommands, runJobUpsertCommand } from './native-job-upsert.js';
import { claimCommands, runClaimCommand } from './native-claims.js';
import { jobTransitionCommands, runJobTransitionCommand } from './native-job-transitions.js';
import { projectionCommands, runProjectionCommand } from './native-projections.js';
import { pendingAnswerCommands, runPendingAnswerCommand } from './native-pending-answers.js';
import { profileCommands, runProfileCommand } from "./native-profile.js";
import { answerCommands, runAnswerCommand } from "./native-answers.js";
import { extractionCommands, runExtractionCommand } from "./native-extractions.js";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { JobsService } from "../workspace-core/jobs.js";
import { NativeJobsRepository, initializeJobsFixture, fixtureError } from "../store/native-jobs.js";
import { loadPosixFlockProvider } from "../store/posix-flock.js";
import { parse, serialize, JobsError } from "../contracts/workspace/values.js";
import { ResumeService } from "../workspace-core/resumes.js";
import { NativeResumeFiles } from "../store/native-resume-files.js";

export async function runJobsCli(args: string[], input: (limit?: number) => Promise<string>): Promise<string> {
  const options = new Map<string, string>();
  let command: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (!key.startsWith("--")) {
      if (command) throw new JobsError("unexpected CLI argument");
      command = key;
    } else {
      if (options.has(key)) throw new JobsError("duplicate CLI option");
      if (["--include-trashed", "--trashed-only", "--replace", "--remember-sensitive", "--all-review-statuses", "--summary-only", "--owner-confirmed", "--owner-confirmed-not-submitted", "--user-confirmed"].includes(key)) options.set(key, "true");
      else {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new JobsError("missing CLI option value");
        options.set(key, value);
      }
    }
  }
  const fields: Record<string, string[]> = {
    ...jobUpsertCommands,
    ...jobTransitionCommands,
    ...projectionCommands,
    ...claimCommands,
    ...pendingAnswerCommands,
    ...profileCommands,
    ...answerCommands,
    ...extractionCommands,
    "fixture-init": [], "job-create": ["--input", "--origin"], "job-get": ["--id", "--include-trashed"],
    "job-list": ["--status", "--include-trashed", "--trashed-only"],
    "job-update": ["--id", "--input", "--expected-revision", "--origin"],
    "resume-import": ["--input", "--path"], "resume-get": ["--id", "--include-trashed"],
    "resume-list": ["--include-trashed", "--trashed-only"], "resume-update": ["--id", "--input", "--expected-revision"],
    "resume-replace": ["--id", "--path", "--expected-revision"], "resume-adopt": ["--id", "--path", "--expected-revision"],
    "resume-set-default": ["--id", "--expected-revision"], "resume-resolve": ["--id"], "resume-check": ["--id"],
  };
  const allowed = fields[command ?? ""];
  if (!allowed || [...options.keys()].some(key => !["--root", "--native-lock", ...allowed].includes(key))) {
    throw new JobsError("unsupported native Jobs command or option");
  }
  const required = (key: string): string => {
    const value = options.get(key);
    if (!value) throw new JobsError(`required option: ${key}`);
    return value;
  };
  const root = required("--root");
  if (command === "fixture-init") { await initializeJobsFixture(root); return '{"initialized":true}'; }
  const repository = new NativeJobsRepository(root, loadPosixFlockProvider(required("--native-lock")));
  const service = new JobsService(repository);
  const resumes = new ResumeService(repository);
  const payload = async () => {
    const file = required("--input");
    // Extraction candidates permit 256 KiB after normalization. Allow JSON
    // escaping and formatting overhead while keeping stdin bounded.
    // Bulk upsert accepts the same input domain through stdin and files, as Python does.
    const limit = Object.hasOwn(jobUpsertCommands, command!) ? Infinity
      : ["resume-proposal-create", "resume-extraction-request-complete"].includes(command!) ? 2 * 1024 * 1024 : 65536;
    return parse(file === "-" ? await input(limit) : await readFile(file, "utf8"));
  };
  if (Object.hasOwn(jobUpsertCommands, command!)) return serialize(await runJobUpsertCommand(command!, repository, options, payload));
  if (Object.hasOwn(jobTransitionCommands, command!)) return serialize(await runJobTransitionCommand(repository, options));
  if (Object.hasOwn(projectionCommands, command!)) return serialize(await runProjectionCommand(command!, repository, options));
  if (Object.hasOwn(claimCommands, command!)) return serialize(await runClaimCommand(command!,repository,options,payload));
  if (Object.hasOwn(pendingAnswerCommands, command!)) return serialize(await runPendingAnswerCommand(command!, repository, options));
  if (Object.hasOwn(profileCommands, command!)) return serialize(await runProfileCommand(command!, repository, options, payload));
  if (Object.hasOwn(answerCommands, command!)) return serialize(await runAnswerCommand(command!, repository, options, payload));
  if (Object.hasOwn(extractionCommands, command!)) return serialize(await runExtractionCommand(command!, repository, options, payload));
  if (command === "resume-import") {
    const path = required("--path"), content = await new NativeResumeFiles(root).readPath(path);
    return serialize(await resumes.import(await payload(), basename(path), content, true));
  }
  if (command === "resume-get") return serialize(await resumes.get(required("--id"), options.has("--include-trashed")));
  if (command === "resume-list") return serialize(await resumes.list(options.has("--include-trashed"), options.has("--trashed-only")));
  if (command === "resume-resolve") return serialize(await resumes.resolve(options.get("--id")));
  if (command === "resume-check") return serialize(await resumes.check(required("--id")));
  if (command === "job-create") return serialize(await service.create(await payload(), options.get("--origin")));
  if (command === "job-get") return serialize(await service.get(required("--id"), options.has("--include-trashed")));
  if (command === "job-list") return serialize(await service.list({
    ...(options.has("--status") ? { status: options.get("--status")! } : {}),
    includeTrashed: options.has("--include-trashed"), trashedOnly: options.has("--trashed-only"),
  }));
  const revision = required("--expected-revision");
  if (!/^[0-9]+$/.test(revision) || BigInt(revision) < 1n) throw new JobsError("expected revision must be a positive integer");
  if (command === "resume-update") return serialize(await resumes.update(required("--id"), await payload(), BigInt(revision)));
  if (command === "resume-set-default") return serialize(await resumes.setDefault(required("--id"), BigInt(revision)));
  if (command === "resume-replace" || command === "resume-adopt") {
    const path = required("--path"), content = await new NativeResumeFiles(root).readPath(path);
    return serialize(await resumes.replace(required("--id"), basename(path), content, BigInt(revision), command === "resume-adopt", true));
  }
  return serialize(await service.update(required("--id"), await payload(), BigInt(revision), options.get("--origin")));
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runJobsCli(process.argv.slice(2), async (limit = 65536) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > limit) throw new JobsError(`input exceeds ${limit / 1024} KiB`);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    });
    process.stdout.write(result + "\n");
  } catch (error) {
    process.stderr.write(fixtureError(error) + "\n");
    process.exitCode = 1;
  }
}
