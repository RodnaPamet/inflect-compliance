/**
 * NAMING A PROPOSAL BY ID DOES NOT WIDEN WHAT THE QUEUE SERVES — #5738.
 *
 * The retrospective reviewer's link (`/agents/proposals?proposal=<id>`) needs the
 * proposals page to read one specific approval: a sample audit draws ACCEPTED and
 * EDITED proposals, while that page's own read asks for PENDING, and the list is
 * bounded at a hundred with no cursor — so an older approval is past the cap and
 * a plain link would resolve to nothing.
 *
 * `listAgentProposals` therefore takes an `ids` filter, and the property that
 * matters is what it does NOT do. The usecase's existing invariant is that
 * QUARANTINED rows are excluded unconditionally, "including when a caller asks",
 * and EXPIRED with them: a quarantined proposal is an injected one a reviewer
 * must never be handed, and an expired one has had its window close.
 *
 * So the id is ANDed with that vocabulary and never substituted for it. These
 * cases read the `where` the usecase builds, because the difference between
 * `{ status, id }` and `{ id }` is invisible in a result set that happens to
 * contain no quarantined rows.
 */
// Typed with its argument, so `mock.calls[0][0]` is the `where`-bearing object
// rather than an empty tuple Prisma's own types would never produce.
const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => []);
const db = { agentProposal: { findMany } };

jest.mock('@/lib/db/rls-middleware', () => ({
    // Stubbed to identity rather than `requireActual`: the point of mocking here
    // is to keep the real database layer out entirely, and `@/lib/prisma` runs
    // `withRlsTripwireExtension` at load time.
    withRlsTripwireExtension: <T,>(client: T): T => client,
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));

import { listAgentProposals } from '@/app-layer/usecases/agent-proposals';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', {
    tenantId: 't-1',
    tenantSlug: 'acme',
    userId: 'u-1',
});

/** The `where` the usecase handed Prisma. */
function whereOf(): Record<string, unknown> {
    expect(findMany).toHaveBeenCalled();
    return findMany.mock.calls[0][0].where;
}

beforeEach(() => {
    findMany.mockClear();
});

describe('the ids filter', () => {
    it('narrows to the named proposals', async () => {
        await listAgentProposals(ctx, { ids: ['p-1', 'p-2'] });
        expect(whereOf().id).toEqual({ in: ['p-1', 'p-2'] });
    });

    it('STILL constrains the status, so an id cannot reach a quarantined row', async () => {
        await listAgentProposals(ctx, { ids: ['p-1'] });
        const where = whereOf();
        // The whole point. With `status` absent, naming the id of a quarantined
        // proposal would hand a reviewer the injected payload the exclusion
        // exists to withhold.
        expect(where.status).toBeDefined();
        const statuses = (where.status as { in?: string[] }).in ?? [];
        expect(statuses).not.toContain('QUARANTINED');
        expect(statuses).not.toContain('EXPIRED');
        expect(statuses).toContain('ACCEPTED');
        expect(statuses).toContain('EDITED');
    });

    it('keeps the tenant filter beside it', async () => {
        await listAgentProposals(ctx, { ids: ['p-1'] });
        expect(whereOf().tenantId).toBe('t-1');
    });

    it('adds no id filter when none is asked for', async () => {
        await listAgentProposals(ctx);
        // Absent, not `{ in: [] }` — an empty `in` matches nothing and would
        // empty the queue for every existing caller.
        expect('id' in whereOf()).toBe(false);
    });

    it('does not let an explicit status widen past the vocabulary either', async () => {
        // The pre-existing rule, re-asserted beside the new filter: the two
        // narrowings compose rather than one unlocking the other.
        await expect(
            listAgentProposals(ctx, { ids: ['p-1'], status: 'QUARANTINED' }),
        ).rejects.toThrow();
    });
});
