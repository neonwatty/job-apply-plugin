#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cleanup, evaluate, prepare, resolveRoute, submissionCommand, transition } from '../qa-replay/coordinator.js';
import { verifyAutoSubmit } from '../qa-replay/auto-submit.js';
import { approveSubmissionBatch, executeSubmissionBatch, previewSubmissionBatch, stopSubmissionBatch, submissionBatchStatus } from '../qa-replay/submission-batch.js';
import { canonical, ReplayError } from '../qa-replay/contracts.js';
function options(args) {
    const command = args[0];
    if (!command || command.startsWith('--'))
        throw new ReplayError('command is required');
    const values = new Map();
    for (let index = 1; index < args.length; index++) {
        const key = args[index];
        if (!key.startsWith('--') || values.has(key))
            throw new ReplayError('invalid command arguments');
        if (key === '--json' || key === '--owner-confirmed')
            values.set(key, true);
        else {
            const value = args[++index];
            if (!value || value.startsWith('--'))
                throw new ReplayError('invalid command arguments');
            values.set(key, value);
        }
    }
    return { command, values };
}
function required(values, key) { const value = values.get(key); if (typeof value !== 'string')
    throw new ReplayError(`required option: ${key}`); return value; }
export async function runReplayCli(args) {
    const parsed = options(args), allowed = { prepare: ['--fixture', '--scenario', '--mode', '--job'], evaluate: ['--run-id'], started: ['--run-id'], reviewed: ['--run-id'],
        resolve: ['--route-token'], cleanup: ['--run-id'], 'verify-auto-submit': ['--fixture', '--json'],
        'submission-preview': ['--run-id'], 'submission-approve': ['--run-id', '--review', '--owner-confirmed'],
        'submission-submit': ['--run-id', '--review'], 'submission-status': ['--run-id'], 'submission-cancel': ['--run-id'],
        'submission-batch-preview': ['--run-ids'], 'submission-batch-approve': ['--batch-id', '--review', '--owner-confirmed'],
        'submission-batch-execute': ['--batch-id'], 'submission-batch-status': ['--batch-id'], 'submission-batch-stop': ['--batch-id'] };
    const fields = allowed[parsed.command];
    if (!fields || [...parsed.values.keys()].some(key => !fields.includes(key)))
        throw new ReplayError('invalid command arguments');
    if (parsed.command === 'prepare')
        return { output: await prepare(required(parsed.values, '--fixture'), required(parsed.values, '--scenario'), parsed.values.has('--mode') ? required(parsed.values, '--mode') : undefined, parsed.values.has('--job') ? required(parsed.values, '--job') : undefined), exitCode: 0 };
    if (parsed.command === 'evaluate') {
        const result = await evaluate(required(parsed.values, '--run-id'));
        return { output: result.report, exitCode: result.code };
    }
    if (parsed.command === 'started' || parsed.command === 'reviewed')
        return { output: await transition(required(parsed.values, '--run-id'), parsed.command), exitCode: 0 };
    if (parsed.command === 'resolve')
        return { output: await resolveRoute(required(parsed.values, '--route-token')), exitCode: 0 };
    if (parsed.command === 'cleanup')
        return { output: await cleanup(required(parsed.values, '--run-id')), exitCode: 0 };
    if (parsed.command === 'submission-batch-preview') {
        return { output: await previewSubmissionBatch(required(parsed.values, '--run-ids').split(',')), exitCode: 0 };
    }
    if (parsed.command.startsWith('submission-batch-')) {
        const batchId = required(parsed.values, '--batch-id');
        if (parsed.command === 'submission-batch-approve') {
            if (parsed.values.get('--owner-confirmed') !== true)
                throw new ReplayError('explicit owner confirmation is required');
            return { output: await approveSubmissionBatch(batchId, required(parsed.values, '--review')), exitCode: 0 };
        }
        const command = parsed.command === 'submission-batch-execute' ? executeSubmissionBatch
            : parsed.command === 'submission-batch-stop' ? stopSubmissionBatch : submissionBatchStatus;
        return { output: await command(batchId), exitCode: 0 };
    }
    if (parsed.command.startsWith('submission-')) {
        const action = parsed.command.slice('submission-'.length);
        if (action === 'approve' && parsed.values.get('--owner-confirmed') !== true) {
            throw new ReplayError('explicit owner confirmation is required');
        }
        const review = action === 'approve' || action === 'submit' ? required(parsed.values, '--review') : undefined;
        return { output: await submissionCommand(required(parsed.values, '--run-id'), action, review), exitCode: 0 };
    }
    const output = await verifyAutoSubmit(required(parsed.values, '--fixture'));
    return { output, exitCode: output.status === 'passed' ? 0 : 1 };
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
    try {
        const result = await runReplayCli(process.argv.slice(2));
        process.stdout.write(`${canonical(result.output)}\n`);
        process.exitCode = result.exitCode;
    }
    catch (error) {
        process.stderr.write(`${error instanceof ReplayError ? error.message : 'replay coordinator failed'}\n`);
        process.exitCode = 2;
    }
}
