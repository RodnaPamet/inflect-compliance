/**
 * The decision-log read is bounded, ordered, and scoped by RLS — not by a
 * `where` clause it writes itself.
 *
 * ── WHY THESE THREE ─────────────────────────────────────────────────────────
 *
 * `AiDecisionLog` is the EU AI Act Art 12 record: one row per model call, for
 * every tenant on the platform. A read of it gets exactly three things wrong in
 * practice, and each is silent:
 *
 *   · UNBOUNDED — no `take`, and a busy tenant's page becomes a full-table
 *     scan that looks fine on a fixture with nine rows;
 *   · WRONG DIRECTION — `asc`, and the surface shows the oldest calls a
 *     workspace ever made rather than what it just did;
 *   · TENANT BY HAND — a `where: { tenantId }` written here rather than RLS,
 *     which reads as safe and moves the isolation decision out of the one
 *     place that enforces it for every other agentic read.
 */
import { listAiDecisions, AI_DECISION_PAGE_SIZE } from '@/app-layer/usecases/ai-decision-log';

const findMany = jest.fn();
jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => unknown) =>
            fn({ aiDecisionLog: { findMany } }),
    ),
}));

const CTX = { tenantId: 't1', userId: 'u1' } as never;

beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
});

describe('listAiDecisions', () => {
    it('runs inside the tenant context rather than filtering by hand', async () => {
        const { runInTenantContext } = jest.requireMock('@/lib/db/rls-middleware');
        await listAiDecisions(CTX);
        expect(runInTenantContext).toHaveBeenCalledTimes(1);
        // The query carries NO tenantId of its own. RLS is the boundary, and a
        // hand-written filter here would be a second one that can disagree.
        const arg = findMany.mock.calls[0][0];
        expect(JSON.stringify(arg.where ?? {})).not.toContain('tenantId');
    });

    it('is bounded, and by the constant the surface renders', async () => {
        await listAiDecisions(CTX);
        expect(findMany.mock.calls[0][0].take).toBe(AI_DECISION_PAGE_SIZE);
    });

    it('returns the NEWEST calls, which is what the surface is opened for', async () => {
        await listAiDecisions(CTX);
        expect(findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
    });

    it('narrows to one digest when asked, so a link can land on it', async () => {
        await listAiDecisions(CTX, { digest: 'abc123' });
        expect(findMany.mock.calls[0][0].where).toEqual({ inputDigest: 'abc123' });
    });

    it('does not narrow when no digest is given', async () => {
        // The control for the assertion above: a `where` that is always set
        // would make the unfiltered surface show nothing at all.
        await listAiDecisions(CTX);
        expect(findMany.mock.calls[0][0].where).toBeUndefined();
    });

    it('serialises the timestamp at the seam, not at the component boundary', async () => {
        // A `Date` does not survive the server->client hop. Converting here is
        // what every other agentic payload in this tree does.
        findMany.mockResolvedValue([
            { id: 'd1', createdAt: new Date('2026-09-22T10:00:00.000Z'), inputDigest: 'x' },
        ]);
        const [row] = await listAiDecisions(CTX);
        expect(row.createdAt).toBe('2026-09-22T10:00:00.000Z');
    });

    it('selects no column the encryption manifest does not carve out', async () => {
        // `outputSummary` is the only free-text column read here, and the
        // manifest carves it out explicitly as "bounded, sanitised AI-output
        // summary — never raw content". Nothing else free-text is selected,
        // so this read cannot become the path that surfaces model output.
        await listAiDecisions(CTX);
        const selected = Object.keys(findMany.mock.calls[0][0].select);
        expect(selected).toContain('outputSummary');
        expect(selected).not.toContain('sessionRef');
    });
});
