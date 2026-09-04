/**
 * Agent-register input rules — the two the schema owns.
 *
 * Both are ALSO enforced by CHECK constraints in the migration, which is the
 * point: the constraint is what no other write path can get around, and these
 * assertions are what proves the SCHEMA layer still refuses independently.
 * A test that only drove a usecase against a real database would stay green
 * with the refinement deleted, because the constraint would catch it — so the
 * assertions below read the Zod result directly and name the issue path.
 */
import {
    AGENT_AUTONOMY_MAX,
    AGENT_AUTONOMY_MIN,
    CreateRegisteredAgentSchema,
    UpdateRegisteredAgentSchema,
} from '@/app-layer/schemas/agent-registry.schemas';

const valid = {
    aiSystemId: 'ai-1',
    name: 'Reconciler',
    autonomyLevel: 3,
    dataAccessScope: 'READ_TENANT_DATA',
    reversibility: 'COMPENSABLE',
    provenance: 'FIRST_PARTY',
    ownerUserId: 'user-1',
};

describe('a third-party agent must name its supplier', () => {
    it('rejects THIRD_PARTY with no vendor, and says which field', () => {
        const result = CreateRegisteredAgentSchema.safeParse({
            ...valid,
            provenance: 'THIRD_PARTY',
        });
        expect(result.success).toBe(false);
        // The PATH is the assertion: an error somewhere in the object would
        // also fail `success`, and would not tell a form which box to light up.
        const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
        expect(paths).toContain('vendorId');
    });

    it('accepts THIRD_PARTY once the vendor is named', () => {
        const result = CreateRegisteredAgentSchema.safeParse({
            ...valid,
            provenance: 'THIRD_PARTY',
            vendorId: 'vendor-1',
        });
        expect(result.success).toBe(true);
    });

    it('applies to a partial update too', () => {
        expect(UpdateRegisteredAgentSchema.safeParse({ provenance: 'THIRD_PARTY' }).success).toBe(
            false,
        );
        expect(
            UpdateRegisteredAgentSchema.safeParse({ provenance: 'THIRD_PARTY', vendorId: 'v' })
                .success,
        ).toBe(true);
    });
});

describe('autonomy is a bounded integer ladder, not a flag', () => {
    it.each([AGENT_AUTONOMY_MIN, 3, AGENT_AUTONOMY_MAX])('accepts %i', (level) => {
        expect(CreateRegisteredAgentSchema.safeParse({ ...valid, autonomyLevel: level }).success)
            .toBe(true);
    });

    it.each([AGENT_AUTONOMY_MIN - 1, AGENT_AUTONOMY_MAX + 1, 2.5])(
        'rejects %s',
        (level) => {
            expect(
                CreateRegisteredAgentSchema.safeParse({ ...valid, autonomyLevel: level }).success,
            ).toBe(false);
        },
    );

    it('rejects a boolean standing in for a level', () => {
        // The register exists because "autonomous" is a spectrum. A caller that
        // sends `true` is not sending rung 1, it is sending the wrong question.
        expect(
            CreateRegisteredAgentSchema.safeParse({ ...valid, autonomyLevel: true }).success,
        ).toBe(false);
    });
});

describe('the three exposure axes carry no default', () => {
    it.each(['dataAccessScope', 'reversibility', 'provenance'] as const)(
        'omitting %s is a rejection, not a zero score',
        (field) => {
            const payload: Record<string, unknown> = { ...valid };
            delete payload[field];
            const result = CreateRegisteredAgentSchema.safeParse(payload);
            expect(result.success).toBe(false);
            const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain(field);
        },
    );
});
