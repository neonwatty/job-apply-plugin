import { TaskIntakeService } from '../workspace-core/task-intake.js';
export const taskIntakeCommands = {
    'task-intake': ['--input', '--origin'],
};
export async function runTaskIntakeCommand(repository, options, payload) {
    return new TaskIntakeService(repository).intake(await payload(), options.get('--origin'));
}
