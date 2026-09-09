import { cp, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const app = dirname(fileURLToPath(import.meta.url));
await access(join(app, ".next/standalone/apps/companion/server.js"));
await cp(join(app, ".next/static"), join(app, ".next/standalone/apps/companion/.next/static"), { recursive: true });
console.log("Companion standalone assets assembled");
