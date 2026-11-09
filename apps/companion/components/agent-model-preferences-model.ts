import { PythonObject } from '../../../src/contracts/python-object';
import { get, set, string, text } from '../../../src/contracts/workspace/values';
import type { Document, Value } from '../../../src/contracts/workspace/values';

export type AgentModelPreferences = {
  codexSearch: string;
  codexApplication: string;
  codexSearchEffort: string;
  codexApplicationEffort: string;
  claudeCodeSearch: string;
  claudeCodeApplication: string;
};

export const defaultAgentModelPreferences: AgentModelPreferences = {
  codexSearch: '', codexApplication: '', codexSearchEffort: '', codexApplicationEffort: '',
  claudeCodeSearch: '', claudeCodeApplication: ''
};

const fields = [
  ['codex', 'search', 'codexSearch'],
  ['codex', 'application', 'codexApplication'],
  ['codex', 'searchReasoningEffort', 'codexSearchEffort'],
  ['codex', 'applicationReasoningEffort', 'codexApplicationEffort'],
  ['claudeCode', 'search', 'claudeCodeSearch'],
  ['claudeCode', 'application', 'claudeCodeApplication']
] as const;
const record = (value: Value): Document => value instanceof PythonObject ? value : new PythonObject<Value>();

export function readAgentModelPreferences(profile: Document): AgentModelPreferences {
  const stored = record(get(profile, 'agentModelPreferences'));
  const result = { ...defaultAgentModelPreferences };
  for (const [host, purpose, field] of fields) {
    result[field] = string(get(record(get(stored, host)), purpose)) ?? '';
  }
  return result;
}

export function validAgentModelId(value: string): boolean {
  return value === '' || /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/u.test(value);
}

export function validCodexReasoningEffort(value: string): boolean {
  return value === '' || value === 'low' || value === 'medium' || value === 'high';
}

/** Return only edited nested keys; profile-patch preserves other settings and future fields. */
export function agentModelPreferencesDiff(profile: Document, draft: AgentModelPreferences): Document {
  const stored = record(get(profile, 'agentModelPreferences'));
  const patch = new PythonObject<Value>();
  for (const [host, purpose, field] of fields) {
    const value = draft[field].trim();
    if (purpose.endsWith('ReasoningEffort')) {
      if (!validCodexReasoningEffort(value)) throw Error('Codex reasoning effort must be Host default, Low, Medium, or High.');
    } else if (!validAgentModelId(value)) throw Error('Model IDs may contain letters, numbers, . _ : / + or -.');
    const before = record(get(stored, host));
    if (value === (string(get(before, purpose)) ?? '')) continue;
    const group = record(get(patch, host));
    set(group, purpose, value ? text(value) : null);
    set(patch, host, group);
  }
  return patch;
}
