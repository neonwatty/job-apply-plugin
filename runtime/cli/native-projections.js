import { WorkspaceProjectionsService } from '../workspace-core/workspace-projections.js';
import { JobsError } from '../contracts/workspace/values.js';
export const projectionCommands = {
    'owner-beta-overview': [], 'needs-attention': [], 'task-snapshot': [], 'job-activity': ['--id'], 'job-preflight': ['--id'],
};
export async function runProjectionCommand(command, repository, options) {
    const service = new WorkspaceProjectionsService(repository);
    if (command === 'owner-beta-overview')
        return service.overview();
    if (command === 'needs-attention')
        return service.attention();
    if (command === 'task-snapshot')
        return service.taskSnapshot();
    const id = options.get('--id');
    if (!id)
        throw new JobsError('required option: --id');
    if (command === 'job-preflight')
        return service.preflight(id);
    return service.activity(id);
}
