/**
 * The shared template→task projection.
 *
 * Four install sites used to spell this mapping themselves, and every one of
 * them wrote a task recorded as `source: MANUAL` — not by setting it, but by
 * never mentioning it and inheriting the schema default. These pin the two
 * fields that fixes, and the sanitisation that has no guard watching it.
 */
import {
    taskFromTemplateTask,
    installableTemplateTasks,
    checklistFromSteps,
} from '@/app-layer/usecases/control/task-from-template';
import { TaskChecklistSchema } from '@/app-layer/schemas/task-checklist.schemas';

const ctx = { tenantId: 't1', userId: 'u1' };

const templateTask = {
    id: 'tt-1',
    title: 'Inventory the key-management lifecycle',
    description: 'Record every key, its owner and its rotation interval.',
    sortOrder: 2,
    phase: 'OPERATE',
    stepsJson: [
        { text: 'List every key in use and where it is stored' },
        { text: 'Name an owner for each key', hint: 'A role, not a person' },
        { text: 'Record the rotation interval and the last rotation date' },
    ],
    evidenceHint: 'The key register, exported',
    suggestedRole: 'Security engineering',
    deprecatedAt: null,
};

describe('taskFromTemplateTask', () => {
    it('records the task as installed from a template, not hand-written', () => {
        const row = taskFromTemplateTask(templateTask, ctx, 'c-1');
        // The whole reason this file exists. Before it, every one of these
        // rows claimed a person wrote it.
        expect(row.source).toBe('TEMPLATE');
        expect(row.templateTaskId).toBe('tt-1');
        // Paired with the ordinary fields, so it cannot pass on a projection
        // that stamps the provenance and drops the task.
        expect(row.title).toBe(templateTask.title);
        expect(row.controlId).toBe('c-1');
        expect(row.tenantId).toBe('t1');
    });

    it('preserves the installer as assignee, which every call site did', () => {
        // Not merely parity: it is the only thing that makes an installed
        // task's assignee a KNOWN value, which is what any later "has a human
        // touched this?" question compares against.
        expect(taskFromTemplateTask(templateTask, ctx, 'c-1').assigneeUserId).toBe('u1');
    });

    it('carries the template\'s advice as metadata, not as task columns', () => {
        const meta = taskFromTemplateTask(templateTask, ctx, 'c-1').metadataJson as Record<
            string,
            unknown
        >;
        expect(meta.phase).toBe('OPERATE');
        expect(meta.evidenceHint).toBe('The key register, exported');
        expect(meta.suggestedRole).toBe('Security engineering');
    });

    it('builds a checklist the schema accepts', () => {
        const row = taskFromTemplateTask(templateTask, ctx, 'c-1');
        const parsed = TaskChecklistSchema.safeParse(row.checklistJson);
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data).toHaveLength(3);
        expect(parsed.success && parsed.data[1].hint).toBe('A role, not a person');
        expect(parsed.success && parsed.data.every((i) => i.done === false)).toBe(true);
    });

    it('gives every item a distinct id, because a toggle addresses one', () => {
        const row = taskFromTemplateTask(templateTask, ctx, 'c-1');
        const ids = (row.checklistJson as Array<{ id: string }>).map((i) => i.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('omits the checklist entirely when a template has no authored steps', () => {
        const { stepsJson: _drop, ...noSteps } = templateTask;
        expect(taskFromTemplateTask(noSteps, ctx, 'c-1').checklistJson).toBeUndefined();
    });
});

describe('checklist sanitisation', () => {
    it('strips markup from authored step text', () => {
        // There is no CI guard for this. `sanitize-rich-text-coverage` is
        // model-keyed and `Task` is already classified, so a new free-text
        // field on it is invisible to that ratchet. This test IS the
        // enforcement.
        const items = checklistFromSteps([
            { text: '<script>alert(1)</script>Rotate the signing key' },
            { text: 'Second step, long enough to be real' },
            { text: 'Third step, also long enough', hint: '<b>bold</b> hint' },
        ]);
        expect(items).toBeDefined();
        expect(JSON.stringify(items)).not.toContain('<script>');
        expect(JSON.stringify(items)).not.toContain('<b>');
        // Paired positive: the text survived, only the markup went.
        expect(items?.[0].text).toContain('Rotate the signing key');
    });

    it('accepts a bare string step as well as an object', () => {
        const items = checklistFromSteps(['A step written as a plain string']);
        expect(items?.[0].text).toBe('A step written as a plain string');
    });

    it('drops a step with no usable text rather than writing an empty item', () => {
        expect(checklistFromSteps([{ hint: 'no text here' }, 42, null])).toBeUndefined();
    });
});

describe('installableTemplateTasks', () => {
    const a = { id: 'a', title: 'A', description: null, sortOrder: 2, deprecatedAt: null };
    const b = { id: 'b', title: 'B', description: null, sortOrder: 0, deprecatedAt: null };
    const gone = { id: 'c', title: 'C', description: null, sortOrder: 1, deprecatedAt: new Date() };

    it('returns authored order, not query order', () => {
        expect(installableTemplateTasks([a, b]).map((t) => t.id)).toEqual(['b', 'a']);
    });

    it('never installs a deprecated task', () => {
        // Deprecated means "removed from the source file". It is never
        // deleted, because a tenant may already have installed it — but it
        // must not be installed AGAIN.
        expect(installableTemplateTasks([a, b, gone]).map((t) => t.id)).toEqual(['b', 'a']);
    });

    it('does not mutate its input', () => {
        const input = [a, b];
        installableTemplateTasks(input);
        expect(input.map((t) => t.id)).toEqual(['a', 'b']);
    });
});
