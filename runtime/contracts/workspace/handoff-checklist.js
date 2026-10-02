import { member, requireCondition as check } from './answer-session-fields.js';
import { JobsError, string } from './values.js';
// Closed field/action categories keep applicant values and form wording out of sessions.
export const handoffActionCodes = [
    'resume_upload', 'passport_country', 'country_of_residence', 'age_over_18',
    'profile_fact', 'saved_answer', 'required_question', 'consent_choice',
    'sign_in', 'verification', 'captcha', 'browser_control', 'other_required_field',
];
export function validateHandoffChecklist(value) {
    if (!Array.isArray(value) || value.length > handoffActionCodes.length)
        throw new JobsError('handoff checklist must be a bounded list');
    check(value.every(item => member(item, handoffActionCodes)), 'handoff checklist contains an unsupported action');
    check(new Set(value.map(string)).size === value.length, 'handoff checklist actions must be unique');
}
