import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';
import { checkWindowsMigrationSource } from '../store/windows-migration-source.js';
const help = 'Usage: migration check --source PATH\nChecks a legacy Windows x64 Store without changing it.\n';
const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(help);
}
else if (args.length !== 3 || args[0] !== 'check' || args[1] !== '--source' || !args[2] || args[2].startsWith('--')) {
    process.stderr.write(help);
    process.exitCode = 2;
}
else if (process.platform !== 'win32' || process.arch !== 'x64') {
    process.stderr.write('Legacy Store migration check requires Windows x64.\n');
    process.exitCode = 2;
}
else {
    try {
        const pluginRoot = await realpath(fileURLToPath(new URL('../..', import.meta.url)));
        await checkWindowsMigrationSource(args[2], await resolvePackagedNativeLock(pluginRoot));
        process.stdout.write('{"schemaVersion":1,"status":"source-checked"}\n');
    }
    catch {
        process.stderr.write('The selected source could not be verified as a private, supported legacy Windows Store. It was left unchanged.\n');
        process.exitCode = 2;
    }
}
