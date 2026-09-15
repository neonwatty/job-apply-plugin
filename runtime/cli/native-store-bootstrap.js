import { JobsError } from '../contracts/workspace/values.js';
export const nativeStoreBootstrapCommands = { init: [], paths: [] };
export function runNativeStoreBootstrapCommand(command, service) {
    if (command === 'paths')
        return service.paths();
    if (command === 'init')
        return service.initialize();
    throw new JobsError('unsupported native Store bootstrap command');
}
