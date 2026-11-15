import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reviewedOracleSources } from '../runtime/native/macos/build.js';

if (process.platform !== 'darwin') throw Error('Native macOS source checks require macOS');
const sources = reviewedOracleSources.map(name => fileURLToPath(new URL('../native/macos/' + name, import.meta.url)));
execFileSync('/usr/bin/xcrun', ['swiftc', '-typecheck', ...sources], { stdio: 'inherit', timeout: 120_000 });
