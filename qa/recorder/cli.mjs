import { runCheckpoint } from "./checkpoint.mjs";
import { RecorderError } from "./errors.mjs";
import { runRecord } from "./record.mjs";

function parseFlags(args, names) {
  if (args.length !== names.length * 2) throw new RecorderError("missing recorder arguments");
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!names.includes(flag) || Object.hasOwn(result, flag) || !value) {
      throw new RecorderError("invalid recorder arguments");
    }
    result[flag] = value;
  }
  if (Object.keys(result).length !== names.length) {
    throw new RecorderError("missing recorder arguments");
  }
  return result;
}

export async function dispatchRecorderCommand(
  args,
  runtime = { runCheckpoint, runRecord },
) {
  const command = args[0];
  if (command === "record") {
    const flags = parseFlags(args.slice(1), ["--cdp-url", "--output"]);
    await runtime.runRecord({
      cdpUrl: flags["--cdp-url"],
      output: flags["--output"],
    });
    return;
  }
  if (command === "checkpoint") {
    const flags = parseFlags(args.slice(1), ["--session", "--kind"]);
    await runtime.runCheckpoint(flags["--session"], flags["--kind"]);
    return;
  }
  throw new RecorderError("invalid recorder command");
}

export function executeRecorderCli(argv = process.argv, runtime, processObject = process) {
  dispatchRecorderCommand(argv.slice(2), runtime).then(
    () => processObject.exit(0),
    (error) => {
      const message = `${error instanceof RecorderError ? error.message : "recorder failed"}\n`;
      processObject.stderr.write(message, () => processObject.exit(1));
    },
  );
}
