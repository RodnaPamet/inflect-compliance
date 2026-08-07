/**
 * The Control write contract — three defects that let the UI and the API
 * disagree about what a control can be.
 *
 * Each of these was reachable from the product: a user clicked something the
 * interface offered and got either a 400 or a silent no-op.
 */
import {
    BulkControlStatusSchema,
    CreateControlSchema,
    SetControlStatusSchema,
} from '@/lib/schemas';

/** The six statuses the detail dropdown offers (buildControlStatusLabels). */
const UI_STATUSES = [
    'NOT_STARTED',
    'PLANNED',
    'IN_PROGRESS',
    'IMPLEMENTING',
    'IMPLEMENTED',
    'NEEDS_REVIEW',
] as const;

describe('bulk status cannot set NOT_APPLICABLE', () => {
    it('rejects NOT_APPLICABLE', () => {
        // N/A is an applicability DECISION: the single-control path requires
        // a justification, stamps applicabilityDecidedBy/At, and writes a
        // CONTROL_APPLICABILITY_CHANGED audit row. The bulk path runs
        // updateMany and can do none of it, so accepting N/A here produced
        // an unjustified, unattributed decision with a mistyped audit row.
        const parsed = BulkControlStatusSchema.safeParse({
            controlIds: ['c1'],
            status: 'NOT_APPLICABLE',
        });
        expect(parsed.success).toBe(false);
    });

    it('still accepts the six real statuses', () => {
        // Closing the bypass must not break the feature.
        for (const status of UI_STATUSES) {
            const parsed = BulkControlStatusSchema.safeParse({
                controlIds: ['c1'],
                status,
            });
            expect({ status, ok: parsed.success }).toEqual({ status, ok: true });
        }
    });
});

describe('the status dropdown and the API agree', () => {
    it('accepts every status the detail dropdown offers', () => {
        // PLANNED and IMPLEMENTING were offered by the UI and rejected by
        // the API with 400 invalid_enum_value.
        for (const status of UI_STATUSES) {
            const parsed = SetControlStatusSchema.safeParse({ status });
            expect({ status, ok: parsed.success }).toEqual({ status, ok: true });
        }
    });

    it('rejects NOT_APPLICABLE, which the dropdown does not offer', () => {
        expect(SetControlStatusSchema.safeParse({ status: 'NOT_APPLICABLE' }).success).toBe(false);
    });

    it('the two status write paths now accept the same set', () => {
        // The whole point of widening one and narrowing the other: a control
        // reachable by bulk action is reachable individually, and vice versa.
        for (const status of UI_STATUSES) {
            expect(SetControlStatusSchema.safeParse({ status }).success).toBe(
                BulkControlStatusSchema.safeParse({ controlIds: ['c1'], status }).success,
            );
        }
    });
});

describe('create accepts the fields createControl writes', () => {
    it('preserves objective, successCriteria and testingMethodology', () => {
        // The schema ends in .strip(), so an undeclared field is REMOVED
        // silently — the caller got a 201 with objective: null and no
        // warning, and agent-proposals parses through this same schema.
        const parsed = CreateControlSchema.parse({
            name: 'Access review',
            objective: 'Ensure access is reviewed quarterly',
            successCriteria: 'All accounts reviewed within 90 days',
            testingMethodology: 'Sample 25 accounts, verify approver',
        });

        expect(parsed.objective).toBe('Ensure access is reviewed quarterly');
        expect(parsed.successCriteria).toBe('All accounts reviewed within 90 days');
        expect(parsed.testingMethodology).toBe('Sample 25 accounts, verify approver');
    });

    it('leaves them absent when not supplied, rather than defaulting', () => {
        const parsed = CreateControlSchema.parse({ name: 'Minimal' });
        expect(parsed.objective).toBeUndefined();
        expect(parsed.successCriteria).toBeUndefined();
        expect(parsed.testingMethodology).toBeUndefined();
    });

    it('accepts explicit null for each', () => {
        // Matching UpdateControlSchema's optional().nullable() shape, so the
        // same body works for create and update.
        const parsed = CreateControlSchema.parse({
            name: 'Nulls',
            objective: null,
            successCriteria: null,
            testingMethodology: null,
        });
        expect(parsed.objective).toBeNull();
        expect(parsed.successCriteria).toBeNull();
        expect(parsed.testingMethodology).toBeNull();
    });
});
