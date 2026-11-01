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

// The read rule (#4896) is its own module and has its own tests
// (`agent-oversight-settings.test.ts`); here it is a seam the read must call.
const mockAssertMayRead = jest.fn(async (_ctx: unknown, _surface: string) => undefined);
jest.mock('@/app-layer/usecases/agent-oversight-settings', () => ({
    assertMayReadOversightSurface: (ctx: unknown, surface: string) => mockAssertMayRead(ctx, surface),
}));

const CTX = {
    tenantId: 't1',
    userId: 'u1',
    permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
} as never;

beforeEach(() => {
    (jest.requireMock('@/lib/db/rls-middleware') as { runInTenantContext: jest.Mock }).runInTenantContext.mockClear();
    mockAssertMayRead.mockClear();
    findMany.mockReset();
    findMany.mockResolvedValue([]);
});

describe('listAiDecisions', () => {
    it('asks the decision-log read rule before it reads anything', async () => {
        await listAiDecisions(CTX);
        expect(mockAssertMayRead).toHaveBeenCalledWith(CTX, 'decisions');
    });

    it('reads nothing when the read rule refuses', async () => {
        mockAssertMayRead.mockRejectedValueOnce(new Error('refused'));
        await expect(listAiDecisions(CTX)).rejects.toThrow('refused');
        expect(findMany).not.toHaveBeenCalled();
    });

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
            { id: 'd1', feature: 'assistant', createdAt: new Date('2026-09-22T10:00:00.000Z'), inputDigest: 'x' },
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
    });

    it('never surfaces sessionRef; a run’s row carries only its run id (#4896)', async () => {
        // `sessionRef` is read, to link a run's rows to their run, and goes no
        // further: on other features it is a session key that can carry text
        // (a composed request's template label).
        findMany.mockResolvedValue([
            { id: 'r', feature: 'agentic-run:audit-prep', sessionRef: 'run_1', createdAt: new Date(), inputDigest: 'x' },
            { id: 't', feature: 'agentic-tool:external', sessionRef: 'run_2', createdAt: new Date(), inputDigest: 'y' },
            { id: 'p', feature: 'agent-proposal', sessionRef: 'compose:Grant a role:abc', createdAt: new Date(), inputDigest: 'z' },
        ]);
        const rows = await listAiDecisions(CTX);
        expect(rows.map((r) => r.runId)).toEqual(['run_1', 'run_2', null]);
        for (const r of rows) expect(r).not.toHaveProperty('sessionRef');
    });
});
