/**
 * A leaver pass — and, since #2687, a JOINER pass — is stored in
 * IntegrationExecution because that is where a connector's runs live. Neither is
 * a control check, and the tenant-wide "automated checks" list must not present
 * either as one.
 *
 * Two reasons, and the second is the stronger. They produce no evidence and
 * attest nothing — listing them beside evidence-producing checks would
 * misdescribe them to whoever reads that page. And that page is reachable with
 * `controls.view`, while every other leaver and joiner surface is gated at
 * OWNER, so letting the rows drift onto it would widen their audience as a side
 * effect of choosing where to store them. The joiner's rows are the more
 * sensitive of the two: they name which of a customer's people the product would
 * CREATE an account for, and under what address.
 *
 * THE JOINER HALF IS HERE BECAUSE IT WAS MISSED ONCE. `.joiner_pass` rows only
 * began to exist when #2687 gave the planner a caller, a schedule and a run
 * route; the exclusion above them was written for a table that contained no such
 * row, so it kept being correct for a reason that had expired. The assertions
 * below are deliberately a MIRRORED PAIR rather than one assertion over a list,
 * so a future third pass added to this table fails the pair-shaped test it is
 * missing from instead of silently inheriting someone else's exclusion.
 */
const mockDb = { integrationExecution: { findMany: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

import { listAllControlChecks } from '@/app-layer/usecases/integrations';
import { LEAVER_PASS_AUTOMATION_SUFFIX, listLeaverPasses } from '@/app-layer/usecases/identity-leaver-pass';
import { JOINER_PASS_AUTOMATION_SUFFIX } from '@/app-layer/usecases/identity-joiner-run';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1' });

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationExecution.findMany.mockResolvedValue([]);
});

describe('listAllControlChecks', () => {
    it('excludes leaver passes at the QUERY, not in the caller', async () => {
        // At the query on purpose. Filtering in the route or the page would let
        // the next caller of this usecase reintroduce the exposure without
        // touching anything that looks security-relevant.
        await listAllControlChecks(ctx);

        const where = mockDb.integrationExecution.findMany.mock.calls[0][0].where;
        expect(where.AND).toContainEqual({
            automationKey: { not: { endsWith: LEAVER_PASS_AUTOMATION_SUFFIX } },
        });
        expect(where.tenantId).toBe('t1');
    });

    it('excludes JOINER passes at the QUERY too — the same exclusion, same reason', async () => {
        // The mirror of the assertion above. `.joiner_pass` rows are written by
        // the pass #2687 scheduled, into this same table, and they were NOT
        // excluded when that landed: the one-key `not` could not hold a second
        // suffix, so adding the joiner silently meant widening the shape as well
        // as the list.
        await listAllControlChecks(ctx);

        const where = mockDb.integrationExecution.findMany.mock.calls[0][0].where;
        expect(where.AND).toContainEqual({
            automationKey: { not: { endsWith: JOINER_PASS_AUTOMATION_SUFFIX } },
        });
    });

    it('carries EXACTLY those two exclusions, and they name different suffixes', async () => {
        // What this adds to the pair above is not what it first looks like, so
        // both halves were mutation-checked rather than argued.
        //
        // The conjunction is ALREADY covered by the pair. Renaming `AND` to `OR`
        // — the mutation that turns two refusals into a filter excluding
        // nothing, since no row can end in both suffixes — reddens all three of
        // these cases, because `where.AND` is then undefined (measured: 3
        // failed, 3 passed).
        //
        // What `toHaveLength(2)` catches is the opposite direction, which the
        // pair genuinely cannot see: `toContainEqual` is satisfied by a
        // SUPERSET, so a third clause added to this array passes both
        // assertions above while silently narrowing the checks list for
        // everyone who reads that page.
        //
        // And the suffix inequality is not pedantry: if the two constants were
        // ever spelled the same, one clause would do the work of both and the
        // pair above would still be green — the exact confusion the joiner's own
        // constant carries a docblock about ("A SIBLING of `.leaver_pass`, never
        // the same key").
        await listAllControlChecks(ctx);

        const where = mockDb.integrationExecution.findMany.mock.calls[0][0].where;
        expect(where.AND).toHaveLength(2);
        expect(JOINER_PASS_AUTOMATION_SUFFIX).not.toBe(LEAVER_PASS_AUTOMATION_SUFFIX);
    });

    it('still scopes to the tenant — the exclusion is an addition, not a replacement', async () => {
        // Guarding the guard: a refactor that rewrites `where` to hold only the
        // new clause would pass the assertion above while dropping tenant
        // isolation, which is the more serious of the two by far.
        await listAllControlChecks(ctx, { limit: 5 });

        const call = mockDb.integrationExecution.findMany.mock.calls[0][0];
        expect(call.where.tenantId).toBe('t1');
        expect(call.take).toBe(5);
    });
});

describe('listLeaverPasses', () => {
    it('reads leaver passes and ONLY leaver passes, most recent first', async () => {
        // The complement of the exclusion above, and it has to be the exact
        // mirror: if these two predicates ever disagree, a pass is either
        // invisible on both surfaces or visible on the controls.view one.
        mockDb.integrationExecution.findMany.mockResolvedValue([]);
        await listLeaverPasses(ctx);

        const call = mockDb.integrationExecution.findMany.mock.calls[0][0];
        expect(call.where).toEqual({
            tenantId: 't1',
            automationKey: { endsWith: LEAVER_PASS_AUTOMATION_SUFFIX },
        });
        expect(call.orderBy).toEqual({ executedAt: 'desc' });
        expect(call.select.resultJson).toBe(true);
    });

    it('caps the read even when the caller asks for more', async () => {
        mockDb.integrationExecution.findMany.mockResolvedValue([]);
        await listLeaverPasses(ctx, { limit: 100000 });
        expect(mockDb.integrationExecution.findMany.mock.calls[0][0].take).toBe(100);
    });
});
