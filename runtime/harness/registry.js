import { WorkflowError } from './contracts.js';
import { identifier, requireCondition, version } from './validation.js';
function schema(value) {
    requireCondition(value && typeof value.parse === 'function', 'invalid_registration');
    // Bind the original parser now; replacing registration.parse later cannot alter the registry.
    return Object.freeze({ parse: value.parse.bind(value) });
}
function limits(value) {
    requireCondition(value && Number.isSafeInteger(value.maxSteps) && value.maxSteps > 0
        && Number.isSafeInteger(value.maxToolCalls) && value.maxToolCalls >= 0
        && Number.isSafeInteger(value.maxChildDepth) && value.maxChildDepth >= 0, 'invalid_registration');
    return Object.freeze({ maxSteps: value.maxSteps, maxToolCalls: value.maxToolCalls, maxChildDepth: value.maxChildDepth });
}
/** Static executable schemas plus metadata; it neither grants user consent nor executes tools. */
export class WorkflowRegistry {
    #profiles = new Map();
    #tools = new Map();
    #workflows = new Map();
    constructor(profiles, workflows) {
        for (const profile of profiles) {
            const id = identifier(profile.id, 'invalid_registration');
            requireCondition(!this.#profiles.has(id), 'invalid_registration');
            const tools = profile.tools.map(tool => {
                const toolId = identifier(tool.id, 'invalid_registration');
                requireCondition(!this.#tools.has(toolId), 'invalid_registration');
                const registration = Object.freeze({ id: toolId, inputSchema: schema(tool.inputSchema) });
                this.#tools.set(toolId, { profileId: id, registration });
                return registration;
            });
            this.#profiles.set(id, Object.freeze({ id, tools: Object.freeze(tools), limits: limits(profile.limits) }));
        }
        for (const workflow of workflows) {
            const id = identifier(workflow.id, 'invalid_registration');
            const workflowVersion = version(workflow.version, 'invalid_registration');
            const key = this.key({ id, version: workflowVersion });
            requireCondition(!this.#workflows.has(key) && typeof workflow.routeDescription === 'string'
                && workflow.routeDescription.trim().length > 0 && workflow.routeDescription.length <= 2048, 'invalid_registration');
            const requiredProfiles = [...workflow.requiredProfiles];
            requireCondition(requiredProfiles.length > 0 && new Set(requiredProfiles).size === requiredProfiles.length
                && requiredProfiles.every(profile => this.#profiles.has(profile)), 'invalid_registration');
            this.#workflows.set(key, Object.freeze({ id, version: workflowVersion,
                routeDescription: workflow.routeDescription, requiredProfiles: Object.freeze(requiredProfiles),
                startInputSchema: schema(workflow.startInputSchema), userEventSchema: schema(workflow.userEventSchema) }));
        }
    }
    key(workflow) { return `${workflow.id}@${workflow.version}`; }
    permitted(workflow, access) {
        return workflow.requiredProfiles.every(profile => access.enabled.includes(profile) && access.authorized.includes(profile));
    }
    eligible(access) {
        return Object.freeze([...this.#workflows.values()].filter(workflow => this.permitted(workflow, access)));
    }
    resolve(identity, access) {
        const workflow = this.#workflows.get(this.key(identity));
        if (!workflow)
            throw new WorkflowError('workflow_unavailable');
        requireCondition(this.permitted(workflow, access), 'profile_unavailable');
        return workflow;
    }
    tool(identity, toolId, access) {
        const workflow = this.resolve(identity, access), tool = this.#tools.get(toolId);
        requireCondition(tool && workflow.requiredProfiles.includes(tool.profileId), 'action_unavailable');
        return tool.registration;
    }
    limits(identity, access) {
        const workflow = this.resolve(identity, access);
        const values = workflow.requiredProfiles.map(profile => this.#profiles.get(profile).limits);
        return Object.freeze({ maxSteps: Math.min(...values.map(value => value.maxSteps)),
            maxToolCalls: Math.min(...values.map(value => value.maxToolCalls)),
            maxChildDepth: Math.min(...values.map(value => value.maxChildDepth)) });
    }
}
