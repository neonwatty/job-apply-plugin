import { access, cp, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const standalone = app => join(app, '.next/standalone/apps/companion');
const readyPath = app => join(standalone(app), '.next/companion-ready.json');

/** A directory created by an interrupted copy is not a completed build. */
export async function standaloneAssembled(app) {
  try {
    const [server, assets, marker] = await Promise.all([
      lstat(join(standalone(app), 'server.js')),
      lstat(join(standalone(app), '.next/static')),
      lstat(readyPath(app)),
    ]);
    if (!server.isFile() || server.isSymbolicLink() || !assets.isDirectory()
      || assets.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink() || marker.size > 1024) return false;
    const [sourceId, servedId, raw] = await Promise.all([
      readFile(join(app, '.next/BUILD_ID'), 'utf8'),
      readFile(join(standalone(app), '.next/BUILD_ID'), 'utf8'),
      readFile(readyPath(app), 'utf8'),
    ]);
    const receipt = JSON.parse(raw);
    return sourceId.trim().length > 0 && sourceId === servedId
      && receipt.schemaVersion === 1 && receipt.buildId === sourceId;
  } catch { return false; }
}

/** Publish readiness only after every static asset has been copied successfully. */
export async function assembleStandalone(app) {
  const ready = readyPath(app), temporary = `${ready}.${process.pid}.tmp`;
  await rm(ready, { force: true });
  try {
    await access(join(standalone(app), 'server.js'));
    const [sourceId, servedId] = await Promise.all([
      readFile(join(app, '.next/BUILD_ID'), 'utf8'),
      readFile(join(standalone(app), '.next/BUILD_ID'), 'utf8'),
    ]);
    if (!sourceId.trim() || sourceId !== servedId) throw Error('Companion build identity differs');
    await rm(join(standalone(app), '.next/static'), { recursive: true, force: true });
    await cp(join(app, '.next/static'), join(standalone(app), '.next/static'), { recursive: true });
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, buildId: sourceId }) + '\n');
    await rename(temporary, ready);
  } finally { await rm(temporary, { force: true }); }
}
