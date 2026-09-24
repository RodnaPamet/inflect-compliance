/**
 * #2838 — the departure reconcile has a CEILING as well as a floor.
 *
 * ═══ THE HOLE ═══
 *
 * `usecases/hris-sync` marks every `source: 'HRIS'` employee the pass did not
 * touch `TERMINATED`. So absence from a feed IS departure from the company, at
 * that one statement, with nothing able to tell the two apart.
 *
 * The existing `passSawRows` guard refuses the catastrophic version — an empty
 * or failed fetch does not wipe the roster — and it is asserted in
 * `hris-resume-parity.test.ts`. What it cannot see is the PARTIAL roster:
 * rows arrived, so the pass "saw rows", but the set is a subset. That is the
 * normal shape of a scoping change (a department-scoped report, an edited
 * filter) and the shape a TRANSFER produces.
 *
 * ═══ WHY THIS IS NOT A MIRROR-ONLY BUG ═══
 *
 * `identity-leaver-pass` selects exactly `status: 'TERMINATED'`, and on a
 * tenant at AUTOMATIC that disables a real directory account unattended. A
 * real AD account was disabled by the scheduled pass on 2026-09-24 (#2749), so
 * the hop from this column to a locked-out employee is proven, not theorised.
 *
 * ═══ HOW THE FIXTURES ARE BUILT ═══
 *
 * Modelled on `identity-sync.test.ts`'s deprovision suite, deliberately: the
 * two reconciles are the same shape over different tables, and a second
 * vocabulary for the same rail would be a cost with no benefit.
 *
 * Each refusal test RULES THE OTHER RAIL OUT BY CONSTRUCTION. A fixture that
 * trips both `passSawRows` and the share cap would stay green with either one
 * deleted, so it could not say which is load-bearing:
 *
 *   • `passSawRows` is tested on an EMPTY roster, where the share cap is not
 *     reached at all.
 *   • the SHARE CAP is tested on a NON-EMPTY roster, where `passSawRows` is
 *     satisfied and cannot be what refuses.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/security/encryption', () => ({
    decryptField: jest.fn(() => '{}'),
    encryptField: jest.fn((s: string) => s),
}));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));
jest.mock('@/app-layer/integrations/registry', () => ({ registry: { getProvider: jest.fn() } }));
// Spread the real module rather than replacing it: `markAuthFailure` reaches
// for `recordConnectionAuthState` from here too, and a bare factory silently
// removes every counter this file does not think about.
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordSyncTruncated: jest.fn(),
}));

import {
    runHrisSync,
    MAX_TERMINATE_SHARE,
    TERMINATE_SHARE_FLOOR,
} from '@/app-layer/usecases/hris-sync';
import { logger } from '@/lib/observability/logger';
import type { NormalizedEmployee } from '@/app-layer/integrations/providers/hris';

const mockDb = {
    integrationConnection: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    integrationExecution: { create: jest.fn(), update: jest.fn() },
    employee: { upsert: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
};

/**
 * The two COUNT queries the rail issues, told apart by the PREDICATE rather
 * than by call order.
 *
 * `syncedAt` in the where-clause means "rows this pass did not touch" — the
 * numerator, what the reconcile would flip. Its absence means "rows this
 * tenant still calls live" — the denominator. Dispatching on the predicate is
 * the point: an assertion keyed to call index would keep passing if the two
 * queries were swapped, which is exactly the numerator/denominator confusion
 * this rail exists to catch.
 */
function countsBy(stale: number, population: number) {
    return async (args: { where?: { syncedAt?: unknown } }) =>
        args?.where?.syncedAt !== undefined ? stale : population;
}

const NOW = new Date('2026-09-24T03:00:00.000Z');

function emp(id: string): NormalizedEmployee {
    return {
        externalId: id,
        hrisRecordId: id,
        fullName: `Person ${id}`,
        workEmail: `${id}@acme.test`,
        status: 'ACTIVE',
        department: 'Eng',
        jobTitle: 'Engineer',
        managerEmail: null,
        startDate: null,
        endDate: null,
    };
}

function stubProvider(employees: NormalizedEmployee[]) {
    return { listEmployees: jest.fn(async () => ({ employees, complete: true, resumeToken: null })) };
}

/** The last `IntegrationExecution.update` — the operator's durable record. */
function persistedRow(): Record<string, unknown> {
    return mockDb.integrationExecution.update.mock.calls.at(-1)?.[0].data;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationConnection.findFirst.mockResolvedValue({
        id: 'conn-1', provider: 'bamboohr', configJson: {}, secretEncrypted: null,
        syncCursor: null, syncPassStartedAt: null,
    });
    mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
    mockDb.integrationExecution.update.mockResolvedValue({});
    mockDb.employee.upsert.mockResolvedValue({});
    mockDb.employee.findMany.mockResolvedValue([]);
    mockDb.employee.update.mockResolvedValue({});
    mockDb.employee.updateMany.mockResolvedValue({ count: 3 });
    mockDb.integrationConnection.updateMany.mockResolvedValue({ count: 1 });
    // 3 of 100 = 3%, under the cap, so the default fixture reconciles.
    mockDb.employee.count.mockImplementation(countsBy(3, 100));
});

describe('the thresholds themselves', () => {
    it('reuse the sibling reconcile’s numbers rather than inventing new ones', () => {
        // Pinned because the VALUES are the claim, not an implementation
        // detail: `identity-sync`'s `MAX_DEPROVISION_SHARE` and the write
        // breaker's `MAX_DISABLE_SHARE` are both 0.1, and all three answer the
        // same question. Three thresholds an operator has to hold apart would
        // be a cost with no benefit.
        expect(MAX_TERMINATE_SHARE).toBe(0.1);
        expect(TERMINATE_SHARE_FLOOR).toBe(5);
    });

    it('has no absolute per-run cap, because the numerator is a standing backlog', () => {
        // NOT an omission. `checkDisableBlastRadius` pairs its share rule with
        // `MAX_DISABLES_PER_RUN = 50`, and that half does not transfer: over
        // there `proposed` counts an ACT and can go down, here it counts every
        // HRIS row untouched since the pass began. Refusing does not clear
        // them, so the count only grows, and an absolute cap over a growing
        // count fires once and then refuses forever while looking deliberate
        // (#2290). Asserted as an ABSENCE from the module's exports, which is
        // the only place a second cap could arrive from.
        const exported = jest.requireActual('@/app-layer/usecases/hris-sync');
        expect(Object.keys(exported).filter((k) => /MAX_TERMINAT|PER_RUN/.test(k)))
            .toStrictEqual(['MAX_TERMINATE_SHARE']);
    });
});

describe('runHrisSync — departure reconcile share cap', () => {
    it('refuses a pass that would terminate a tenth of the live HRIS workforce', async () => {
        // 30 of 100. The roster was NON-EMPTY, so `passSawRows` is satisfied
        // and cannot be what refuses this — only the share cap can. This is
        // the partial-scoping failure `passSawRows` cannot see: the feed still
        // answers, employees keep arriving, and a whole department does not.
        mockDb.employee.count.mockImplementation(countsBy(30, 100));
        const r = await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([emp('a')]),
        });

        // NOT ONE ROW FLIPPED — the assertion the whole issue is about.
        expect(mockDb.employee.updateMany).not.toHaveBeenCalled();
        expect(r.departed).toBe(0);

        // And the run does not claim to be clean, in the RETURN and on the
        // ROW. Asserting only the return would check the half a caller sees;
        // the row is the operator's only durable record, and a green badge
        // over a withheld reconcile is a refusal nobody sees.
        expect(r.status).toBe('PARTIAL');
        expect(r.errorMessage).toContain('30.0%');
        const row = persistedRow();
        expect(row.status).toBe('PARTIAL');
        expect(row.errorMessage).toContain('Refusing to mark 30 of 100');
        expect(row.resultJson).toMatchObject({
            terminateRefused: 'share_cap',
            terminateProposed: 30,
            departed: 0,
        });
    });

    it('names the transfer/scoping cause in the message an operator reads', async () => {
        // The refusal text is the only thing that tells whoever opens the row
        // WHAT to go and look at. "Cap exceeded" would send them to the cap.
        mockDb.employee.count.mockImplementation(countsBy(30, 100));
        await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([emp('a')]),
        });

        const msg = String(persistedRow().errorMessage);
        expect(msg).toMatch(/feed that\s+narrowed/);
        expect(msg).toMatch(/directory disable/);
    });

    it('logs the refusal at WARN, not at the INFO the clean path uses', async () => {
        mockDb.employee.count.mockImplementation(countsBy(30, 100));
        await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([emp('a')]),
        });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('REFUSED'),
            expect.objectContaining({ proposed: 30, reason: 'share_cap' }),
        );
        // A refusal that also emitted the success line would be a run reported
        // twice, once wrongly.
        expect(logger.info).not.toHaveBeenCalledWith(
            'hris-sync complete',
            expect.anything(),
        );
    });

    it('lets ordinary churn through — 6 of 100 is not an anomaly', async () => {
        // THE POSITIVE CONTROL the refusal tests need. 6 is above the floor,
        // so the share rule is live and evaluating; 6% is under the cap. A
        // rail that refused this would be a rail operators switch off.
        mockDb.employee.count.mockImplementation(countsBy(6, 100));
        const r = await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([emp('a')]),
        });

        expect(mockDb.employee.updateMany).toHaveBeenCalledTimes(1);
        expect(r.status).toBe('PASSED');
        const row = persistedRow();
        expect(row.status).toBe('PASSED');
        expect(row.errorMessage).toBeNull();
        expect(row.resultJson).not.toHaveProperty('terminateRefused');
    });

    it('does not refuse a small tenant where two departures are half the roster', async () => {
        // 2 of 4 is 50% and would trip a bare percentage rule every time
        // somebody leaves. `TERMINATE_SHARE_FLOOR` is what keeps the share
        // rule silent at the bottom end — and `passSawRows` is what still
        // covers this tenant when the roster comes back empty, which is the
        // case that actually endangers it.
        mockDb.employee.count.mockImplementation(countsBy(2, 4));
        const r = await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW,
            provider: stubProvider([emp('a'), emp('b')]),
        });

        expect(mockDb.employee.updateMany).toHaveBeenCalledTimes(1);
        expect(r.status).toBe('PASSED');
    });

    it('judges the reconcile with the reconcile’s OWN predicate', async () => {
        // The numerator and the write must describe the same set. Measuring
        // one and writing another is how a rail authorises a batch it never
        // looked at (#2498, in the leaver path). Asserted as object IDENTITY
        // of the where-clause, because a field-by-field copy is exactly what
        // drifts.
        await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([emp('a')]),
        });

        const counted = mockDb.employee.count.mock.calls[0][0].where;
        const written = mockDb.employee.updateMany.mock.calls[0][0].where;
        expect(written).toBe(counted);
        // Positive control — `toBe` on two undefineds would also pass.
        expect(written.syncedAt).toEqual({ lt: NOW });
        expect(written.source).toBe('HRIS');
    });

    it('measures the denominator over the same table and source, one predicate narrower', async () => {
        // The two halves of a fraction have to count the same kind of thing
        // over the same set. Narrowing the DENOMINATOR alone can newly CREATE
        // a refusal on a rail whose refusals latch, so it is pinned.
        await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([emp('a')]),
        });

        expect(mockDb.employee.count).toHaveBeenCalledTimes(2);
        const denominator = mockDb.employee.count.mock.calls[1][0].where;
        expect(denominator).toStrictEqual({
            tenantId: 't1',
            source: 'HRIS',
            status: { not: 'TERMINATED' },
        });
    });

    it('does not count at all when nothing is proposed', async () => {
        // A no-op surfacing as a refusal teaches operators that refusals are
        // noise, and then the one that matters is ignored too. Zero proposed
        // must also not pay for the denominator query.
        mockDb.employee.count.mockImplementation(countsBy(0, 100));
        const r = await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([emp('a')]),
        });

        expect(mockDb.employee.count).toHaveBeenCalledTimes(1);
        expect(r.status).toBe('PASSED');
        expect(mockDb.employee.updateMany).toHaveBeenCalledTimes(1);
    });

    it('clears the pass marker on a refusal, so the next pass starts fresh', async () => {
        // The roster read FINISHED; it is the reconcile that was held, so
        // there is no page to resume. Left set, `passStartedAt` would stay
        // pinned to the refused pass's instant on every later run — it is read
        // from this column — and each pass would widen the set it proposes
        // while never advancing.
        mockDb.employee.count.mockImplementation(countsBy(30, 100));
        await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([emp('a')]),
        });

        const cleared = mockDb.integrationConnection.updateMany.mock.calls
            .map((c) => c[0].data)
            .find((d) => d.syncCursor === null);
        expect(cleared).toEqual({ syncCursor: null, syncPassStartedAt: null });
    });

    it('still upserts the roster it did read — the refusal is of the SWEEP only', async () => {
        // Fail-closed means the mirror over-reports people as PRESENT, which
        // is the recoverable direction. It does not mean the pass throws away
        // the rows it legitimately saw.
        mockDb.employee.count.mockImplementation(countsBy(30, 100));
        const r = await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW,
            provider: stubProvider([emp('a'), emp('b')]),
        });

        expect(mockDb.employee.upsert).toHaveBeenCalledTimes(2);
        expect(r.upserted).toBe(2);
    });
});

describe('the pre-existing passSawRows guard is untouched', () => {
    it('an empty-but-complete roster still reconciles nothing, and still reports PASSED', async () => {
        // REGRESSION PIN, not a new claim. This arm predates #2838 and its
        // behaviour is deliberately unchanged: the share cap is added ON TOP
        // of it, never in place of it. A fixture of 4 proposed is below
        // `TERMINATE_SHARE_FLOOR`, so the share rule is silent by definition
        // and only `passSawRows` can be what holds this.
        mockDb.employee.count.mockImplementation(countsBy(4, 4));
        const r = await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([]),
        });

        expect(mockDb.employee.updateMany).not.toHaveBeenCalled();
        // The rail is not even reached — no count is issued on this arm.
        expect(mockDb.employee.count).not.toHaveBeenCalled();
        expect(r.status).toBe('PASSED');
    });

    it('still reconciles when an EARLIER run of the same pass saw rows', async () => {
        // The counter-case, and why the guard is not simply "refuse on empty".
        // Under resume the last run of a pass reads an empty final page
        // whenever the roster size is an exact multiple of the per-run cap.
        // `Boolean(...)` rather than `!== null` is what keeps an ABSENT marker
        // from reading as "resumed".
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', provider: 'bamboohr', configJson: {}, secretEncrypted: null,
            syncCursor: 'LAST_PAGE', syncPassStartedAt: new Date('2026-09-23T03:00:00.000Z'),
        });
        mockDb.employee.count.mockImplementation(countsBy(3, 100));
        const r = await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([]),
        });

        expect(mockDb.employee.updateMany).toHaveBeenCalledTimes(1);
        expect(r.status).toBe('PASSED');
        // And it reconciles against the PASS start, not this run's `now` —
        // otherwise the reconcile would see nothing older than itself.
        expect(mockDb.employee.updateMany.mock.calls[0][0].where.syncedAt)
            .toEqual({ lt: new Date('2026-09-23T03:00:00.000Z') });
    });

    it('the share cap still applies to a resumed pass', async () => {
        // The two guards compose rather than shadowing each other: a resumed
        // pass satisfies `passSawRows` through the marker, which is exactly
        // the state in which the share cap is the only rail left.
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', provider: 'bamboohr', configJson: {}, secretEncrypted: null,
            syncCursor: 'LAST_PAGE', syncPassStartedAt: new Date('2026-09-23T03:00:00.000Z'),
        });
        mockDb.employee.count.mockImplementation(countsBy(30, 100));
        const r = await runHrisSync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([]),
        });

        expect(mockDb.employee.updateMany).not.toHaveBeenCalled();
        expect(r.status).toBe('PARTIAL');
    });
});
