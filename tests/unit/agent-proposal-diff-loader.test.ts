/**
 * The seam that reads the BASE a reviewer's diff is computed against.
 *
 * `computeProposalDiff` is pure and is tested on its own; this file is about the
 * half that talks to the database, where three things can go wrong in ways the
 * pure function cannot see:
 *
 *   - the base could be read STALE or not at all, and a missing row must arrive
 *     as an explicit "no target" rather than as an empty object that would
 *     render as "every field is currently blank";
 *   - the read could be per-proposal. A queue page holds up to a hundred rows,
 *     so a round trip each is a latency cliff on the one page that must stay
 *     fast enough to actually be read;
 *   - the rows could be matched by id alone. Ids are cuids and a collision
 *     across two tables is not a real risk, but keying by id alone would let a
 *     CONTROL row satisfy a proposal whose kind says RISK - silently repairing a
 *     mis-kinded row instead of showing the reviewer that something is wrong.
 */
const db = {
    risk: { findMany: jest.fn() },
    control: { findMany: jest.fn() },
    policy: { findMany: jest.fn() },
    finding: { findMany: jest.fn() },
};

/**
 * Wrapped in a spy so the test can see whether a TRANSACTION was opened at all,
 * not merely whether a query ran inside one. `runInTenantContext` is one
 * `prisma.$transaction`, and entering it for a page of proposals that have no
 * base to read is a round trip bought for nothing.
 */
const runInTenantContext = jest.fn(
    (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
);
jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: (...a: unknown[]) =>
        runInTenantContext(...(a as [unknown, (d: unknown) => unknown])),
}));

import { buildProposalDiffs, buildProposalDiff } from '@/app-layer/usecases/agent-proposal-diff';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'reviewer-1' });

const proposal = (over: Partial<{
    id: string;
    kind: string;
    operation: string;
    payloadJson: string;
    targetEntityId: string | null;
}>) => ({
    id: 'p1',
    kind: 'RISK',
    operation: 'UPDATE',
    payloadJson: JSON.stringify({ likelihood: 9 }),
    targetEntityId: 'risk-1',
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    runInTenantContext.mockImplementation((_ctx, fn) => fn(db));
    db.risk.findMany.mockResolvedValue([]);
    db.control.findMany.mockResolvedValue([]);
    db.policy.findMany.mockResolvedValue([]);
    db.finding.findMany.mockResolvedValue([]);
});

describe('the base is read once per KIND, not once per proposal', () => {
    it('collapses many update proposals of one kind into a single query', async () => {
        const rows = ['risk-1', 'risk-2', 'risk-3', 'risk-1'].map((targetEntityId, i) =>
            proposal({ id: `p${i}`, targetEntityId }),
        );
        db.risk.findMany.mockResolvedValue([
            { id: 'risk-1', likelihood: 4 },
            { id: 'risk-2', likelihood: 4 },
            { id: 'risk-3', likelihood: 4 },
        ]);

        await buildProposalDiffs(ctx, rows);

        expect(db.risk.findMany).toHaveBeenCalledTimes(1);
        const where = db.risk.findMany.mock.calls[0][0].where;
        // Deduped, tenant-scoped, and bounded. The duplicate `risk-1` appears
        // once: two proposals against one record must not double the id list.
        expect(where.id.in).toStrictEqual(['risk-1', 'risk-2', 'risk-3']);
        expect(where.tenantId).toBe('t1');
        expect(db.risk.findMany.mock.calls[0][0].take).toBe(3);
    });

    it('opens no transaction at all when no proposal is an update', async () => {
        const diffs = await buildProposalDiffs(ctx, [
            proposal({ id: 'c1', operation: 'CREATE', targetEntityId: null }),
            proposal({ id: 'c2', operation: 'CREATE', targetEntityId: null }),
        ]);

        // A create has no base, so even ENTERING the transaction is a round trip
        // bought for nothing - and creates are the most common row in the queue.
        // Asserting on the transaction rather than on the queries inside it is
        // deliberate: the per-kind guards below would keep the query counts at
        // zero on their own, so a query-only assertion could not tell whether
        // this early exit still existed.
        expect(runInTenantContext).not.toHaveBeenCalled();
        expect(diffs.get('c1')!.status).toBe('CREATE');
    });

    it('queries only the kinds the batch actually names', async () => {
        db.risk.findMany.mockResolvedValue([{ id: 'risk-1', likelihood: 4 }]);

        await buildProposalDiffs(ctx, [
            proposal({ id: 'p-risk', kind: 'RISK', targetEntityId: 'risk-1' }),
            proposal({ id: 'p-create', operation: 'CREATE', targetEntityId: null }),
        ]);

        // The transaction IS opened here - the paired positive that stops the
        // three negatives below passing on a batch that read nothing.
        expect(runInTenantContext).toHaveBeenCalledTimes(1);
        expect(db.risk.findMany).toHaveBeenCalledTimes(1);
        expect(db.control.findMany).not.toHaveBeenCalled();
        expect(db.policy.findMany).not.toHaveBeenCalled();
        expect(db.finding.findMany).not.toHaveBeenCalled();
    });
});

describe('a target that could not be read is reported as missing, not as blank', () => {
    it('gives the orphan TARGET_MISSING and leaves its neighbour alone', async () => {
        db.risk.findMany.mockResolvedValue([{ id: 'risk-1', likelihood: 4 }]);

        const diffs = await buildProposalDiffs(ctx, [
            proposal({ id: 'p-ok', targetEntityId: 'risk-1' }),
            proposal({ id: 'p-orphan', targetEntityId: 'risk-gone' }),
        ]);

        expect(diffs.get('p-ok')!.status).toBe('UPDATE');
        expect(diffs.get('p-orphan')!.status).toBe('TARGET_MISSING');
        // Every input gets an entry. An ABSENT key and an uncomputable diff
        // must not be the same thing to the caller either - the page would then
        // have to invent a diff for a row it was never told about.
        expect([...diffs.keys()].sort()).toStrictEqual(['p-ok', 'p-orphan']);
    });

    it('will not satisfy a RISK proposal with a CONTROL row of the same id', async () => {
        // Both tables return a row with the same id. Keyed by id alone, the
        // control's row would silently become the risk proposal's base.
        db.control.findMany.mockResolvedValue([{ id: 'shared-id', name: 'A control' }]);
        db.risk.findMany.mockResolvedValue([]);

        const diffs = await buildProposalDiffs(ctx, [
            proposal({ id: 'p-risk', kind: 'RISK', targetEntityId: 'shared-id' }),
            proposal({
                id: 'p-control',
                kind: 'CONTROL',
                targetEntityId: 'shared-id',
                payloadJson: JSON.stringify({ name: 'A control' }),
            }),
        ]);

        expect(diffs.get('p-risk')!.status).toBe('TARGET_MISSING');
        // The paired positive: the control proposal DID find its base, so the
        // assertion above is about the keying and not about an empty result.
        expect(diffs.get('p-control')!.status).toBe('NO_CHANGES');
    });
});

describe('the single-proposal convenience returns the same answer', () => {
    it('computes one diff against a freshly read base', async () => {
        db.risk.findMany.mockResolvedValue([{ id: 'risk-1', likelihood: 4 }]);

        const diff = await buildProposalDiff(ctx, proposal({ id: 'solo' }));

        expect(diff.status).toBe('UPDATE');
        expect(diff.fields).toStrictEqual([
            { field: 'likelihood', before: '4', after: '9', changed: true },
        ]);
    });
});
