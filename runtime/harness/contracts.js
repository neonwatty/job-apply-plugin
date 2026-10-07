/** Never include model arguments, applicant values, schema diagnostics, or causes in public errors. */
export class WorkflowError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'WorkflowError';
    }
}
