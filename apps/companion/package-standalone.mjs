import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleStandalone } from './standalone-assets.mjs';
const app = dirname(fileURLToPath(import.meta.url));
await assembleStandalone(app);
console.log('Companion standalone assets assembled');
