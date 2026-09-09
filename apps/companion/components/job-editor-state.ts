import { textFields, type Job, type JobFields } from './contracts';
export type Editor = {
    selected: Job | null;
    fields: JobFields;
    dirty: Set<keyof JobFields>;
    latest: Job | null;
    missing: boolean;
};
export function fieldsFor(job: Job | null): JobFields {
    const text = (key: string) => typeof job?.[key] === 'string' ? job[key] : '';
    return {
        url: text('url'), role: text('role'), company: text('company'), location: text('location'), workplaceType: text('workplaceType'), employmentType: text('employmentType'), compensation: text('compensation'), notes: text('notes'), description: text('description'), resumeId: typeof job?.resumeId === 'string' ? job.resumeId : null, priority: typeof job?.priority === 'number' ? job.priority : 0
    };
}
export function openEditor(selected: Job | null): Editor {
    return {
        selected, fields: fieldsFor(selected), dirty: new Set(), latest: null, missing: false
    };
}
export function edit(editor: Editor, fields: Partial<JobFields>): Editor {
    const next = { ...editor.fields, ...fields };
    const original = fieldsFor(editor.selected);
    const dirty = new Set<keyof JobFields>();
    for (const key of [...textFields, 'resumeId', 'priority'] as const) {
        if (next[key] !== original[key]) dirty.add(key);
    }
    return { ...editor, fields: next, dirty };
}
export function observe(editor: Editor, jobs: Job[]): Editor {
    if (!editor.selected)
        return editor;
    const latest = jobs.find(job => job.id === editor.selected?.id);
    if (!latest) return { ...editor, missing: true, latest: null };
    const present = { ...editor, missing: false };
    return latest.revision > Math.max(editor.selected.revision, editor.latest?.revision ?? 0) ? {
        ...present, latest
    } : present;
}
export function reapply(editor: Editor): Editor {
    if (!editor.latest || editor.missing)
        return editor;
    const fresh = openEditor(editor.latest);
    const fields = {
        ...fresh.fields
    };
    for (const key of editor.dirty) {
        if (key === 'priority')
            fields.priority = editor.fields.priority;
        else if (key === 'resumeId')
            fields.resumeId = editor.fields.resumeId;
        else
            fields[key] = editor.fields[key];
    }
    return edit(fresh, fields);
}
