/**
 * WHAT THE EXTERNAL-WRITE DWELL COUNTS, AND FOR WHICH RUNGS (#2861 step 4).
 *
 * `countEvidenceForRung` is DB-backed, so the behavioural half of this change
 * lives in `tests/integration/external-write-policy.test.ts`. What is asserted
 * here is the part that does not need a database and that an integration test
 * would prove only incidentally:
 *
 *   1. the PREDICATE each rung is counted with — the `where` the query is issued
 *      against, which is the join the whole fix is about;
 *   2. that the rungs with an evidence REQUIREMENT are exactly the rungs the
 *      counter can answer for.
 *
 * (2) is the one that has already gone wrong twice in this subsystem. #2993's
 * counter read a table nothing wrote, so the number was 0 for ever; before step
 * 4 the `PROPOSE_ONLY` branch returned `undefined` for ever. Both are the same
 * shape — a rung whose gate can never be satisfied — and neither is a type
 * error, because `MODE_MIN_EVIDENCE` is a value. So it is asserted.
 */
const mockTx = {
    integrationConnection: { findFirst: jest.fn() },
    externalWriteJournal: { count: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

import {
    EVIDENCE_COUNTABLE_RUNGS,
    getExternalWritePolicy,
} from '@/app-layer/usecases/external-write-policy';
import { LADDER, MODE_MIN_EVIDENCE } from '@/lib/integrations/external-write-ladder';
import { makeRequestContext } from '../helpers/make-context';

const CONN = 'cmconnaaaaaaaaaaaaaaaaaa';
const ctx = makeRequestContext('OWNER', { tenantId: 't1', userId: 'u1' });
const SINCE = new Date('2026-01-01T00:00:00.000Z');

/** The `where` the counter was issued with, or undefined if it never ran. */
async function evidenceQueryFor(mode: string): Promise<Record<string, unknown> | undefined> {
    mockTx.integrationConnection.findFirst.mockResolvedValue({
        id: CONN,
        name: 'HRM',
        externalWriteMode: mode,
        externalWriteModeSince: SINCE,
    });
    mockTx.externalWriteJournal.count.mockResolvedValue(3);
    await getExternalWritePolicy(ctx, CONN);
    const call = mockTx.externalWriteJournal.count.mock.calls[0];
    return call ? (call[0] as { where: Record<string, unknown> }).where : undefined;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('the rungs that demand evidence are the rungs that can be counted', () => {
    it('has a counting predicate for every rung in MODE_MIN_EVIDENCE', () => {
        // THE INVARIANT. A rung listed as requiring evidence and absent from the
        // predicate table is a gate that answers "could not count" for ever —
        // #2993's failure in a new costume, and no type catches it.
        const demanded = Object.keys(MODE_MIN_EVIDENCE).filter(
            (rung) => MODE_MIN_EVIDENCE[rung as (typeof LADDER)[number]] !== undefined,
        );
        expect(demanded.length).toBeGreaterThan(0);
        expect(demanded.sort()).toEqual([...EVIDENCE_COUNTABLE_RUNGS].sort());
    });

    it('counts NEITHER of the rungs that are asked for nothing', () => {
        // The complement, stated so the equality above cannot be satisfied by a
        // table that simply lists every rung. DISABLED produces nothing by
        // construction; AUTOMATIC is the top rung, so nothing is widened off it.
        expect(EVIDENCE_COUNTABLE_RUNGS).not.toContain('DISABLED');
        expect(EVIDENCE_COUNTABLE_RUNGS).not.toContain('AUTOMATIC');
    });
});

describe('the predicate each rung is counted with', () => {
    it('counts DRY_RUN as recorded intents, scoped to the connection and window', async () => {
        const where = await evidenceQueryFor('DRY_RUN');
        expect(where).toEqual({
            tenantId: 't1',
            connectionId: CONN,
            attemptedAt: { gte: SINCE },
            mode: 'DRY_RUN',
            outcome: 'RECORDED_ONLY',
        });
    });

    it('counts PROPOSE_ONLY through the journal row an APPROVAL opens', async () => {
        // The join. `AgentProposal` has no `connectionId` — it is inside the
        // encrypted `payloadJson` and unfilterable in SQL — so an approved
        // proposal is counted as the `mode = 'PROPOSE_ONLY'` row that
        // `openApprovedExternalWrite` writes, which nothing else in the build
        // produces.
        const where = await evidenceQueryFor('PROPOSE_ONLY');
        expect(where).toEqual({
            tenantId: 't1',
            connectionId: CONN,
            attemptedAt: { gte: SINCE },
            mode: 'PROPOSE_ONLY',
            // RECORDED_ONLY excluded, and as a positive list rather than a
            // negation: an outcome added later must be left OUT (gate stays
            // shut) rather than counted in (authority widens).
            outcome: { in: ['PENDING', 'APPLIED', 'FAILED', 'INDETERMINATE'] },
        });
    });

    it('does not fold the two rungs into one query', async () => {
        // The mutation this guards: a predicate table whose PROPOSE_ONLY entry
        // was copied from DRY_RUN would count dry-run intents as approvals and
        // grant unattended writes off the wrong proof. Asserted as inequality so
        // it survives a change to either predicate's wording.
        const dry = await evidenceQueryFor('DRY_RUN');
        jest.clearAllMocks();
        const propose = await evidenceQueryFor('PROPOSE_ONLY');
        expect(dry).not.toEqual(propose);
    });
});

describe('a rung with no predicate is UNCOUNTED, not counted as zero', () => {
    it('issues no query at AUTOMATIC and reports undefined', async () => {
        // `undefined` must keep meaning "could not count". `refusalForMove`
        // carries a separate sentence for it, and collapsing the two would make
        // a probe failure read as a satisfied gate.
        mockTx.integrationConnection.findFirst.mockResolvedValue({
            id: CONN,
            name: 'HRM',
            externalWriteMode: 'AUTOMATIC',
            externalWriteModeSince: SINCE,
        });
        const policy = await getExternalWritePolicy(ctx, CONN);
        expect(policy.evidenceInWindow).toBeUndefined();
        expect(mockTx.externalWriteJournal.count).not.toHaveBeenCalled();
    });

    it('issues no query at DISABLED, which is skipped before the counter', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue({
            id: CONN,
            name: 'HRM',
            externalWriteMode: 'DISABLED',
            externalWriteModeSince: SINCE,
        });
        const policy = await getExternalWritePolicy(ctx, CONN);
        expect(policy.evidenceInWindow).toBeUndefined();
        expect(mockTx.externalWriteJournal.count).not.toHaveBeenCalled();
    });

    it('issues no query when the rung has no window to measure', async () => {
        // A rung with an evidence requirement but no `modeSince` has no window,
        // so there is nothing to count SINCE. The ladder refuses that move on its
        // own sentence ("no recorded start"), which must not be pre-empted by a 0.
        mockTx.integrationConnection.findFirst.mockResolvedValue({
            id: CONN,
            name: 'HRM',
            externalWriteMode: 'PROPOSE_ONLY',
            externalWriteModeSince: null,
        });
        const policy = await getExternalWritePolicy(ctx, CONN);
        expect(policy.evidenceInWindow).toBeUndefined();
        expect(mockTx.externalWriteJournal.count).not.toHaveBeenCalled();
    });
});

describe('the counted number reaches the state the ladder reads', () => {
    it('publishes what the query returned, not a recomputation', async () => {
        // The positive control for every `not.toHaveBeenCalled()` above: the
        // count does flow through to `evidenceInWindow`, so those assertions are
        // about the rung and not about a seam that never runs.
        mockTx.integrationConnection.findFirst.mockResolvedValue({
            id: CONN,
            name: 'HRM',
            externalWriteMode: 'PROPOSE_ONLY',
            externalWriteModeSince: SINCE,
        });
        mockTx.externalWriteJournal.count.mockResolvedValue(7);
        const policy = await getExternalWritePolicy(ctx, CONN);
        expect(policy.evidenceInWindow).toBe(7);
    });
});
