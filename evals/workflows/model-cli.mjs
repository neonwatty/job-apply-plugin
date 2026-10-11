#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const liveReadiness = Object.freeze({
  ready: false,
  reason: 'No verified model transport with an exclusively JSON proposal surface is configured.',
  evidence: 'Codex CLI 0.160.0 debug prompt-input exposes messages but does not enumerate actual tool schemas. Disabling shell_tool and using MCP enabled_tools does not establish absence of other builtins.',
  prerequisites: [
    'A trusted transport must prove the model cannot use computer, Store, approval, or network tools before inference.',
    'Use a separate host controller for canonical fixture reads and protected approvals; pass only closed proposals and sanitized model-channel replies.',
    'Capture complete transport traces, enforce process deadlines, and terminate descendants before fixture cleanup.',
    'Run an actual conversation before reporting model calls or latency; retain all failed and incomplete runs.',
  ],
  modelToolCalls: null,
  modelLatencyMs: null,
  unnecessaryQuestions: null,
});

/** Explicitly blocked default. A prompt or unchecked boolean is not an isolation mechanism. */
export function unavailableLiveTransport() {
  const blocked = async () => { throw Error(liveReadiness.reason); };
  return Object.freeze({ kind: 'live_model', verifyIsolation: blocked, next: blocked });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--readiness') {
    process.stderr.write('Usage: node evals/workflows/model-cli.mjs --readiness\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(JSON.stringify(liveReadiness, null, 2) + '\n');
    process.exitCode = 2;
  }
}
