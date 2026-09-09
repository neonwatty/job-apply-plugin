import { randomUUID } from 'node:crypto';
import { copy, get, has, set, object, int, integer, string, text, keys, same, fromJSON, JobsError } from '../contracts/workspace/values.js';
import { id, label, paths, order, validateGroups } from '../contracts/workspace/fact-groups.js';
import { casefold } from '../contracts/workspace/casefold.js';
export class FactGroupsService {
    repository;
    now;
    uuid;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), uuid = () => randomUUID().replaceAll('-', '')) {
        this.repository = repository;
        this.now = now;
        this.uuid = uuid;
    }
    list() {
        return this.repository.groupsTransaction(async (document) => object(get(validateGroups(document), 'groups'), 'fact groups.groups').entries()
            .map(([, value]) => object(value, 'fact group record')).sort((a, b) => Number(int(get(a, 'order')) - int(get(b, 'order')))
            || text(casefold(string(get(a, 'label')))).compare(text(casefold(string(get(b, 'label')))))
            || text(string(get(a, 'id'))).compare(text(string(get(b, 'id'))))));
    }
    async get(groupId) {
        id(groupId);
        return this.repository.groupsTransaction(async (document) => get(object(get(validateGroups(document), 'groups'), 'fact groups.groups'), groupId));
    }
    async create(value) {
        const input = object(value, 'fact group');
        if (!has(input, 'label') || !has(input, 'paths') || keys(input).some(key => !['label', 'paths', 'order'].includes(key)))
            throw new JobsError('fact group requires label and paths');
        const name = label(get(input, 'label')), selected = paths(get(input, 'paths'));
        const requested = get(input, 'order') === null ? null : order(get(input, 'order'));
        return this.repository.groupsTransaction(async (document, save) => {
            const groups = object(get(validateGroups(document), 'groups'), 'fact groups.groups');
            this.unique(groups, name);
            const maximum = groups.entries().reduce((max, [, value]) => {
                const next = int(get(object(value, 'fact group record'), 'order'));
                return next > max ? next : max;
            }, -100n);
            const groupId = id(this.uuid()), now = this.now();
            const record = fromJSON({ id: groupId, label: name, revision: 1, createdAt: now, updatedAt: now });
            set(record, 'paths', selected);
            set(record, 'order', integer(requested ?? maximum + 100n));
            // Fail closed at the persisted order bound instead of creating unreadable state.
            order(get(record, 'order'));
            set(groups, groupId, record);
            set(object(get(document, 'metadata'), 'fact groups.metadata'), 'updatedAt', text(now));
            await save(document);
            return record;
        });
    }
    async update(groupId, value, revision) {
        id(groupId);
        const input = object(value, 'fact group patch');
        if (!input.size || keys(input).some(key => !['label', 'paths', 'order'].includes(key)))
            throw new JobsError('fact group patch must contain label, paths, or order');
        return this.change(groupId, revision, async (document, groups, current, save) => {
            const next = copy(current);
            if (has(input, 'label')) {
                const name = label(get(input, 'label'));
                this.unique(groups, name, groupId);
                set(next, 'label', text(name));
            }
            if (has(input, 'paths'))
                set(next, 'paths', paths(get(input, 'paths')));
            if (has(input, 'order'))
                set(next, 'order', integer(order(get(input, 'order'))));
            if (['label', 'paths', 'order'].every(key => same(get(next, key), get(current, key))))
                return current;
            const now = this.now();
            set(next, 'revision', integer(revision + 1n));
            set(next, 'updatedAt', text(now));
            set(groups, groupId, next);
            set(object(get(document, 'metadata'), 'fact groups.metadata'), 'updatedAt', text(now));
            await save(document);
            return next;
        });
    }
    async delete(groupId, revision) {
        return this.change(groupId, revision, async (document, groups, _current, save) => {
            groups.delete(text(groupId));
            set(object(get(document, 'metadata'), 'fact groups.metadata'), 'updatedAt', text(this.now()));
            await save(document);
            return fromJSON({ deleted: true, id: groupId });
        });
    }
    change(groupId, revision, operation) {
        id(groupId);
        if (revision < 1n)
            throw new JobsError('fact group expected revision must be a positive integer');
        return this.repository.groupsTransaction(async (document, save) => {
            const groups = object(get(validateGroups(document), 'groups'), 'fact groups.groups'), value = get(groups, groupId);
            if (value === null)
                throw new JobsError('fact group does not exist');
            const current = object(value, 'fact group record');
            if (int(get(current, 'revision')) !== revision)
                throw new JobsError('fact group revision conflict');
            return operation(document, groups, current, save);
        });
    }
    unique(groups, name, except) {
        if (groups.entries().some(([key, value]) => string(key) !== except && casefold(string(get(object(value, 'fact group record'), 'label'))) === casefold(name)))
            throw new JobsError('active fact group label already exists');
    }
}
