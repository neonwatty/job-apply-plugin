import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';
import { checkWindowsMigrationSource } from '../store/windows-migration-source.js';
import { copyWindowsStoreForMigration, rollbackWindowsStoreMigration } from '../store/windows-store-migration.js';

const help = 'Usage: migration check --source PATH\n       migration copy --source PATH --target PATH\n'
  + '       migration rollback --source PATH --migrated PATH --target PATH\n';
const [command, sourceFlag, source, flag, path, targetFlag, target, ...extra] = process.argv.slice(2);
const pathValue = (value: string | undefined): value is string => Boolean(value && !value.startsWith('--'));
const sourceArgs = sourceFlag === '--source' && pathValue(source);
const check = command === 'check' && sourceArgs && flag === undefined;
const copy = command === 'copy' && sourceArgs && flag === '--target' && pathValue(path) && targetFlag === undefined;
const rollback = command === 'rollback' && sourceArgs && flag === '--migrated' && pathValue(path)
  && targetFlag === '--target' && pathValue(target) && extra.length === 0;
if ((command === '--help' || command === '-h') && sourceFlag === undefined) {
  process.stdout.write(help);
} else if (!check && !copy && !rollback) {
  process.stderr.write(help);
  process.exitCode = 2;
} else if (process.platform !== 'win32' || process.arch !== 'x64') {
  process.stderr.write('Legacy Store migration requires Windows x64.\n');
  process.exitCode = 2;
} else {
  try {
    const pluginRoot = await realpath(fileURLToPath(new URL('../..', import.meta.url)));
    const addon = await resolvePackagedNativeLock(pluginRoot);
    if (rollback) await rollbackWindowsStoreMigration(source, path, target, addon);
    else if (copy) await copyWindowsStoreForMigration(source, path, addon);
    else await checkWindowsMigrationSource(source, addon);
    const status = rollback ? 'recovery-ready' : copy ? 'copy-ready' : 'source-checked';
    process.stdout.write(JSON.stringify({ schemaVersion: 1, status }) + '\n');
  } catch {
    const message = rollback
      ? 'The rollback copy failed. Use the retained legacy Store, its migrated Store, and a separate unused destination.'
      : copy
        ? 'The migration copy failed. Use a private, supported legacy Store and a separate unused destination.'
        : 'The selected source could not be verified as a private, supported legacy Windows Store. It was left unchanged.';
    process.stderr.write(message + '\n');
    process.exitCode = 2;
  }
}
