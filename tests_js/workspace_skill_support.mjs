import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Validation reads the reachable references; runtime agents load them conditionally.
export function skillText(root, name) {
  return execFileSync(process.env.PYTHON || 'python3', [
    join(root, 'scripts', 'skill_documents.py'),
    join(root, 'skills', name, 'SKILL.md'),
  ], { encoding: 'utf8' });
}
