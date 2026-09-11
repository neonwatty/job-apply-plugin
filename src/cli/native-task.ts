import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Keep module/addon load failures inside the redacted task protocol boundary. */
export async function runTaskCli(args: string[]): Promise<{ output: string; exitCode: number }> {
  try {
    return await (await import('./task-runner.js')).runTask(args);
  } catch {
    return { output: '{"error":{"code":"store_unavailable","message":"The canonical store is unavailable."},"ok":false}\n', exitCode: 2 };
  }
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const result = await runTaskCli(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
