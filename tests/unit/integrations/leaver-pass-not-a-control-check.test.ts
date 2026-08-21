/**
 * A leaver pass is stored in IntegrationExecution because that is where a
 * connector's runs live. It is not a control check, and the tenant-wide
 * "automated checks" list must not present it as one.
 *
 * Two reasons, and the second is the stronger. It produces no evidence and
 * attests nothing — listing it beside evidence-producing checks would
 * misdescribe it to whoever reads that page. And that page is reachable with
 * `controls.view`, while every other leaver surface is gated at OWNER, so
 * letting the rows drift onto it would widen their audience as a side effect of
 * choosing where to store them.
 */
const mockDb = { integrationExecution: { findMany: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

import { listAllControlChecks } from '@/app-layer/usecases/integrations';
import { LEAVER_PASS_AUTOMATION_SUFFIX, listLeaverPasses } from '@/app-layer/usecases/identity-leaver-pass';
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
        expect(where.automationKey).toEqual({ not: { endsWith: LEAVER_PASS_AUTOMATION_SUFFIX } });
        expect(where.tenantId).toBe('t1');
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
