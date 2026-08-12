/**
 * B3-5 (c) — `Task.metadataJson` is a BOUNDED open extension point.
 *
 * The decision this file enforces (rather than describes):
 *
 *   `metadataJson` stays an open bag. `findingSource` / `controlGapType` do
 *   NOT get promoted to columns, because promotion is earned by *relational*
 *   need, not popularity:
 *
 *     - `findingId` WAS promoted (TP-3): it needs an FK with
 *       `onDelete: SetNull`, a `[tenantId, findingId]` index, and a
 *       reconciliation lookup that closes the finding when the task ends.
 *     - `findingSource` / `controlGapType` were DEMOTED into this bag by
 *       migration `20260310191803_unified_task_model`, which folded `Issue`
 *       into `Task` and dropped the `FindingSource` / `ControlGapType` enum
 *       types. They are display-only: no `where`, `orderBy`, `select` or
 *       join anywhere. Re-promoting them would revert that migration and add
 *       mostly-NULL columns to a hot table.
 *
 * What was actually broken was the BOUNDARY, not the shape: both public task
 * routes typed `metadataJson: z.any()`, and the usecase-side validator only
 * asserts "is a plain object". An untrusted client could therefore persist
 * arbitrarily deep, arbitrarily large JSON into a tenant row. These tests
 * fail if that regresses.
 */
import { CreateTaskSchema, TaskMetadataSchema, UpdateTaskSchema, TASK_METADATA_MAX_KEYS, TASK_METADATA_MAX_KEY_LENGTH, TASK_METADATA_MAX_VALUE_LENGTH } from '@/lib/schemas';
import { parseSchemaModels } from '../../helpers/prisma-schema-models';

describe('TaskMetadataSchema — bounded open extension point', () => {
    it('accepts the keys the live producers actually write', () => {
        // The manual create form (_form/useNewTaskForm.ts) and the
        // server-side materializers, in one payload.
        const payload = {
            findingSource: 'EXTERNAL_AUDITOR',
            controlGapType: 'DESIGN',
            findingId: 'fnd_123',
            auditId: 'aud_123',
            checklistItemId: 'chk_1',
            source: 'NIS2_GAP_ASSIGNMENT',
            questionId: 'q1',
            legalBasis: 'Art. 21',
            assignmentId: 'asg_1',
            respondentRole: 'CISO',
            href: '/audits/nis2-gap/respond/asg_1',
            suggestedRespondent: 'ops',
            migratedFrom: 'Issue',
        };
        expect(TaskMetadataSchema.parse(payload)).toEqual(payload);
    });

    it('accepts scalar value types', () => {
        const payload = { s: 'x', n: 42, b: true, nul: null };
        expect(TaskMetadataSchema.parse(payload)).toEqual(payload);
    });

    it('accepts an empty bag', () => {
        expect(TaskMetadataSchema.parse({})).toEqual({});
    });

    // ── The bounds. Each of these PASSED under `z.any()`. ──────────────

    it('rejects a nested object value (unbounded depth)', () => {
        const r = TaskMetadataSchema.safeParse({
            evil: { deeply: { nested: 'blob' } },
        });
        expect(r.success).toBe(false);
    });

    it('rejects an array value', () => {
        expect(TaskMetadataSchema.safeParse({ evil: [1, 2, 3] }).success).toBe(
            false,
        );
    });

    it('rejects more than TASK_METADATA_MAX_KEYS keys', () => {
        const tooMany: Record<string, string> = {};
        for (let i = 0; i <= TASK_METADATA_MAX_KEYS; i++) tooMany[`k${i}`] = 'v';
        expect(Object.keys(tooMany).length).toBeGreaterThan(
            TASK_METADATA_MAX_KEYS,
        );
        expect(TaskMetadataSchema.safeParse(tooMany).success).toBe(false);

        const atLimit: Record<string, string> = {};
        for (let i = 0; i < TASK_METADATA_MAX_KEYS; i++) atLimit[`k${i}`] = 'v';
        expect(TaskMetadataSchema.safeParse(atLimit).success).toBe(true);
    });

    it('rejects an oversized string value', () => {
        const big = 'x'.repeat(TASK_METADATA_MAX_VALUE_LENGTH + 1);
        expect(TaskMetadataSchema.safeParse({ k: big }).success).toBe(false);
        expect(
            TaskMetadataSchema.safeParse({
                k: 'x'.repeat(TASK_METADATA_MAX_VALUE_LENGTH),
            }).success,
        ).toBe(true);
    });

    it('rejects an oversized or empty key', () => {
        const longKey = 'k'.repeat(TASK_METADATA_MAX_KEY_LENGTH + 1);
        expect(TaskMetadataSchema.safeParse({ [longKey]: 'v' }).success).toBe(
            false,
        );
        expect(TaskMetadataSchema.safeParse({ '': 'v' }).success).toBe(false);
    });
});

describe('task request schemas enforce the metadata bound at the API edge', () => {
    const base = { title: 'A task' };

    it('CreateTaskSchema rejects a nested metadata blob', () => {
        expect(
            CreateTaskSchema.safeParse({
                ...base,
                metadataJson: { evil: { nested: true } },
            }).success,
        ).toBe(false);
    });

    it('CreateTaskSchema accepts the form-shaped metadata', () => {
        const r = CreateTaskSchema.safeParse({
            ...base,
            type: 'AUDIT_FINDING',
            metadataJson: {
                findingSource: 'PEN_TEST',
                controlGapType: 'OPERATING',
            },
        });
        expect(r.success).toBe(true);
        expect(r.success && r.data.metadataJson).toEqual({
            findingSource: 'PEN_TEST',
            controlGapType: 'OPERATING',
        });
    });

    it('UpdateTaskSchema rejects a nested metadata blob', () => {
        expect(
            UpdateTaskSchema.safeParse({
                metadataJson: { evil: ['a', 'b'] },
            }).success,
        ).toBe(false);
    });

    it('metadataJson stays optional on both schemas', () => {
        expect(CreateTaskSchema.safeParse(base).success).toBe(true);
        expect(UpdateTaskSchema.safeParse({ title: 'x' }).success).toBe(true);
    });
});

describe('Task promotion criterion — relational keys get columns, display keys do not', () => {
    const task = parseSchemaModels().find((m) => m.name === 'Task');

    it('parses the Task model (parser sanity)', () => {
        expect(task).toBeDefined();
        expect(task!.scalarFieldNames.length).toBeGreaterThan(10);
    });

    it('findingId IS a column, and is relational (FK + index)', () => {
        // It earned promotion: it is a real FK and it is indexed.
        expect(task!.hasField('findingId')).toBe(true);
        expect(
            task!.relationFkFieldGroups.some((g) => g.includes('findingId')),
        ).toBe(true);
        expect(
            task!.blockIndexes.some((idx) => idx.includes('findingId')),
        ).toBe(true);
    });

    it('findingSource / controlGapType are NOT columns — they stay in the bag', () => {
        // Promoting either would revert migration 20260310191803, which
        // demoted them (and dropped their enum types) when Issue folded
        // into the unified Task model. If a future PR promotes one, it must
        // delete this assertion deliberately — and justify the relational
        // need the way findingId did.
        expect(task!.hasField('findingSource')).toBe(false);
        expect(task!.hasField('controlGapType')).toBe(false);
        expect(task!.hasField('metadataJson')).toBe(true);
    });
});
