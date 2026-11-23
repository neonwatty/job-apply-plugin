import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';
import { checkWindowsMigrationSource } from '../store/windows-migration-source.js';
import { copyWindowsStoreForMigration } from '../store/windows-store-migration.js';
const help = 'Usage: migration check --source PATH\n       migration copy --source PATH --target PATH\n'
    + 'Checks or copies a legacy Windows x64 Store while keeping the original intact.\n';
const [command, sourceFlag, source, targetFlag, target, ...extra] = process.argv.slice(2);
const pathValue = (value) => Boolean(value && !value.startsWith('--'));
const sourceArgs = sourceFlag === '--source' && pathValue(source);
const check = command === 'check' && sourceArgs && targetFlag === undefined;
const copy = command === 'copy' && sourceArgs && targetFlag === '--target' && pathValue(target) && extra.length === 0;
if ((command === '--help' || command === '-h') && sourceFlag === undefined) {
    process.stdout.write(help);
}
else if (!check && !copy) {
    process.stderr.write(help);
    process.exitCode = 2;
}
else if (process.platform !== 'win32' || process.arch !== 'x64') {
    process.stderr.write('Legacy Store migration requires Windows x64.\n');
    process.exitCode = 2;
}
else {
    try {
        const pluginRoot = await realpath(fileURLToPath(new URL('../..', import.meta.url)));
        const addon = await resolvePackagedNativeLock(pluginRoot);
        if (copy)
            await copyWindowsStoreForMigration(source, target, addon);
        else
            await checkWindowsMigrationSource(source, addon);
        process.stdout.write(JSON.stringify({ schemaVersion: 1, status: copy ? 'copy-ready' : 'source-checked' }) + '\n');
    }
    catch {
        process.stderr.write(copy
            ? 'The migration copy failed. Use a private, supported legacy Store and a separate unused destination.\n'
            : 'The selected source could not be verified as a private, supported legacy Windows Store. It was left unchanged.\n');
        process.exitCode = 2;
    }
}
