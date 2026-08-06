/**
 * Parity test for the four independent lists of risk lifecycle states.
 *
 * WHY THIS EXISTS: MITIGATED existed in the Prisma `RiskStatus` enum, in
 * `BulkRiskStatusSchema`, and in `RISK_STATUS_VALUES` (which builds the
 * detail page's status combobox) — but NOT in `SetRiskStatusSchema`. The
 * option was therefore offered in the UI, PATCHing it returned 400, and
 * the identical transition succeeded via bulk-select on the list page.
 * Four hand-maintained copies of one enum, and nothing compared them.
 *
 * Rather than assert MITIGATED specifically (which would pass again the
 * moment a sixth state is added to three lists and not the fourth), this
 * derives the expected set from the Prisma enum — the schema is the
 * source of truth — and holds the other three to it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SetRiskStatusSchema, BulkRiskStatusSchema } from '@/lib/schemas';
import { RISK_STATUS_VALUES } from '@/app/t/[tenantSlug]/(app)/risks/_shared/risk-options';

/** The `status` enum member of a `z.object({ status: z.enum([...]) })`. */
function statusOptionsOf(schema: { shape: Record<string, unknown> }): string[] {
    const field = schema.shape.status as { options?: readonly string[] };
    if (!field?.options) throw new Error('schema has no `status` z.enum field');
    return [...field.options].sort();
}

/** Parse `enum RiskStatus { … }` straight out of the Prisma schema. */
function prismaRiskStatusValues(): string[] {
    const enums = readFileSync(
        path.resolve(__dirname, '../../prisma/schema/enums.prisma'),
        'utf8',
    );
    const block = enums.match(/enum RiskStatus \{([^}]*)\}/);
    if (!block) throw new Error('enum RiskStatus not found in enums.prisma');
    return block[1]
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .filter(Boolean)
        .sort();
}

describe('risk status enum parity', () => {
    const expected = prismaRiskStatusValues();

    it('the Prisma enum is the five-state lattice we think it is', () => {
        // A sanity anchor: if this changes, the three assertions below are
        // measuring against a moved target and deserve a human look.
        expect(expected).toEqual(['ACCEPTED', 'CLOSED', 'MITIGATED', 'MITIGATING', 'OPEN']);
    });

    it('SetRiskStatusSchema accepts every state (the MITIGATED regression)', () => {
        expect(statusOptionsOf(SetRiskStatusSchema as never)).toEqual(expected);
    });

    it('BulkRiskStatusSchema accepts every state', () => {
        expect(statusOptionsOf(BulkRiskStatusSchema as never)).toEqual(expected);
    });

    it('the UI offers exactly the states the API accepts', () => {
        // The bug was not that the UI was wrong — it was that the UI was
        // RIGHT and the single-risk API disagreed with it.
        expect([...RISK_STATUS_VALUES].sort()).toEqual(expected);
    });

    it.each(['OPEN', 'MITIGATING', 'MITIGATED', 'ACCEPTED', 'CLOSED'])(
        'parses %s on the single-risk path',
        (status) => {
            expect(SetRiskStatusSchema.parse({ status })).toEqual({ status });
        },
    );
});
