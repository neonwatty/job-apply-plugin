import { JobsError } from '../contracts/workspace/values.js';
export function fixtureError(error) {
    return error instanceof JobsError ? error.message : 'native fixture operation failed; inspect the Store before retrying';
}
