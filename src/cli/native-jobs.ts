import { profileCommands, runProfileCommand } from "./native-profile.js";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JobsService } from "../workspace-core/jobs.js";
import { NativeJobsRepository, initializeJobsFixture, fixtureError } from "../store/native-jobs.js";
import { loadPosixFlockProvider } from "../store/posix-flock.js";
import { parse, serialize, JobsError } from "../contracts/workspace/values.js";

export async function runJobsCli(args: string[], input: () => Promise<string>): Promise<string> {
  const options = new Map<string, string>();
  let command: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (!key.startsWith("--")) {
      if (command) throw new JobsError("unexpected CLI argument");
      command = key;
    } else {
      if (options.has(key)) throw new JobsError("duplicate CLI option");
      if (["--include-trashed", "--trashed-only", "--replace"].includes(key)) options.set(key, "true");
      else {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new JobsError("missing CLI option value");
        options.set(key, value);
      }
    }
  }
  const fields: Record<string, string[]> = {
    ...profileCommands,
    "fixture-init": [], "job-create": ["--input", "--origin"], "job-get": ["--id", "--include-trashed"],
    "job-list": ["--status", "--include-trashed", "--trashed-only"],
    "job-update": ["--id", "--input", "--expected-revision", "--origin"],
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
  const payload = async () => {
    const file = required("--input");
    return parse(file === "-" ? await input() : await readFile(file, "utf8"));
  };
  if (Object.hasOwn(profileCommands, command!)) return serialize(await runProfileCommand(command!, repository, options, payload));
  if (command === "job-create") return serialize(await service.create(await payload(), options.get("--origin")));
  if (command === "job-get") return serialize(await service.get(required("--id"), options.has("--include-trashed")));
  if (command === "job-list") return serialize(await service.list({
    ...(options.has("--status") ? { status: options.get("--status")! } : {}),
    includeTrashed: options.has("--include-trashed"), trashedOnly: options.has("--trashed-only"),
  }));
  const revision = required("--expected-revision");
  if (!/^[0-9]+$/.test(revision) || BigInt(revision) < 1n) throw new JobsError("expected revision must be a positive integer");
  return serialize(await service.update(required("--id"), await payload(), BigInt(revision), options.get("--origin")));
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runJobsCli(process.argv.slice(2), async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 65536) throw new JobsError("input exceeds 64 KiB");
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
