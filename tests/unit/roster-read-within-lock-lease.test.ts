/**
 * #2508 — the roster read is composed with the lock lease it runs under.
 *
 * ═══ WHAT GOES WRONG WITHOUT IT ═══
 *
 * `jobs/hris-sync.ts` takes a per-connection lease before calling the usecase,
 * and that lease is the only thing making the run the sole writer. A lease is
 * reaped by `acquireSyncLock` once it is older than `SYNC_LOCK_TTL_MS`, and a
 * reaped lease does NOT abort the run holding it — it simply lets a second run
 * start. The two then share `syncCursor` and `syncPassStartedAt`: whichever
 * finishes its pass first clears both and reconciles against its own
 * `passStartedAt`, terminating employees the other has not reached, which the
 * other upserts back to ACTIVE.
 *
 * The arithmetic that makes that reachable lives in the guard
 * (`tests/guards/sync-transaction-budget-composes.test.ts`). What lives HERE
 * is the conduct that arithmetic assumes, in the three places it can be
 * silently dropped:
 *
 *   1. the usecase hands the provider a deadline at all;
 *   2. the Workday provider FORWARDS it past its own token exchange;
 *   3. the roster reader actually stops on it — and stops in the one way that
 *      is progress rather than a permanent failure, i.e. with a resume token.
 *
 * Point 3's ending is the sharp edge. `usecases/hris-sync.ts` splits a
 * truncated roster on whether a `resumeToken` came back: WITH one it is a
 * PARTIAL the next run continues; WITHOUT one it is `ERROR, noRetry: true` —
 * permanent, for that connection, forever. A deadline that stopped the read
 * without handing back a cursor would convert "throttled provider" into "a
 * roster that can never finish", which is worse than the overlap being closed.
 *
 * ═══ WHY A PASSTHROUGH DB MOCK IS ENOUGH HERE ═══
 *
 * `tests/unit/sync-transaction-shape.test.ts` argues at length that a
 * `(ctx, fn) => fn(db)` mock cannot show anything about transaction nesting or
 * dead clients, and it is right. None of the claims below are about
 * transactions: they are about which ARGUMENTS cross a seam. The transaction
 * shape is proved there, against a runner built for it.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(fakeDb),
}));
jest.mock('@/lib/security/encryption', () => ({
    decryptField: jest.fn(() => '{}'),
    encryptField: jest.fn((s: string) => s),
}));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));
jest.mock('@/app-layer/integrations/registry', () => ({ registry: { getProvider: jest.fn() } }));
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordSyncTruncated: jest.fn(),
}));

import { runHrisSync } from '@/app-layer/usecases/hris-sync';
import { ROSTER_READ_DEADLINE_MS } from '@/app-layer/integrations/sync-transaction';
import {
    readWorkdayRoster,
    WORKDAY_MAX_PAGES_PER_RUN,
    WORKDAY_PAGE_SIZE,
    type WorkdayRosterConfig,
} from '@/app-layer/integrations/providers/workday/roster';
import { WorkdayProvider } from '@/app-layer/integrations/providers/workday';
import type { HrisSyncDeps, ListEmployeesResult, NormalizedEmployee } from '@/app-layer/integrations/providers/hris';
import type { resolveWorkdayAccessToken, WorkdaySecret } from '@/app-layer/integrations/providers/workday/token';

// ── A db that answers, and records nothing ───────────────────────────────

const fakeDb = {
    integrationConnection: {
        findFirst: async () => ({
            id: 'conn-1',
            provider: 'workday',
            configJson: {},
            secretEncrypted: null,
            syncCursor: null,
            syncPassStartedAt: null,
        }),
        update: async () => ({}),
        updateMany: async () => ({ count: 0 }),
    },
    integrationExecution: {
        create: async () => ({ id: 'exec-1' }),
        update: async () => ({}),
    },
    employee: {
        upsert: async () => ({}),
        findMany: async () => [],
        update: async () => ({}),
        updateMany: async () => ({ count: 0 }),
    },
};

// ── Workday fixtures ─────────────────────────────────────────────────────

const cfg: WorkdayRosterConfig = {
    host: 'wd2-impl-services1.workday.com',
    tenant: 'acme',
    reportPath: '/ccx/service/customreport2/acme/ISU/Roster',
};

const row = (i: number) => ({
    employeeId: `E${i}`,
    legalName: `Person ${i}`,
    primaryWorkEmail: `p${i}@acme.test`,
    workerStatus: 'Active',
});

/**
 * A clock the test moves by hand, and a fetch that moves it.
 *
 * Every page costs `perPageMs` of wall clock. Nothing sleeps — a deadline
 * measured against a real ten minutes would be untestable, and a deadline
 * measured against `jest.advanceTimersByTime` would still not advance
 * `Date.now()` inside an awaited loop the way a slow socket does.
 */
function pagedFetchOnAClock(total: number, perPageMs: number) {
    const state = { nowMs: 0, calls: 0 };
    const fetchImpl = jest.fn(async (url: string) => {
        state.calls += 1;
        state.nowMs += perPageMs;
        const offset = Number(new URL(url).searchParams.get('Offset') ?? '0');
        const slice = Array.from(
            { length: Math.max(0, Math.min(WORKDAY_PAGE_SIZE, total - offset)) },
            (_, k) => row(offset + k),
        );
        return { ok: true, status: 200, json: async () => ({ Report_Entry: slice }) } as unknown as Response;
    });
    return { state, fetchImpl, now: () => new Date(state.nowMs) };
}

/** More rows than one run could ever read, so only a stop condition ends it. */
const HUGE_ROSTER = WORKDAY_PAGE_SIZE * WORKDAY_MAX_PAGES_PER_RUN * 4;
const PER_PAGE_MS = 1_000;

describe('the roster reader stops on the read deadline', () => {
    it('stops after the pages that fit, and hands back a cursor at that offset', async () => {
        const PAGES_AFFORDED = 3;
        const { state, fetchImpl, now } = pagedFetchOnAClock(HUGE_ROSTER, PER_PAGE_MS);

        const out = await readWorkdayRoster(cfg, 'tok', null, {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            now,
            readDeadlineAt: PAGES_AFFORDED * PER_PAGE_MS,
        });

        expect(state.calls).toBe(PAGES_AFFORDED);
        expect(out.employees).toHaveLength(PAGES_AFFORDED * WORKDAY_PAGE_SIZE);
        // PROGRESS, NOT FAILURE. `complete: false` WITHOUT a token is the
        // usecase's permanent `noRetry: true` arm — see the module doc.
        expect(out.complete).toBe(false);
        expect(out.resumeToken).toBe(String(PAGES_AFFORDED * WORKDAY_PAGE_SIZE));
    });

    it('and the SAME fetch reads every page it is allowed to when there is no deadline', async () => {
        // The positive control for the test above. Without it, a reader that
        // stopped after three pages for any reason at all — or one that never
        // paged — would satisfy it. This pins that the deadline is what
        // stopped the read, by removing only the deadline.
        const { state, fetchImpl, now } = pagedFetchOnAClock(HUGE_ROSTER, PER_PAGE_MS);

        const out = await readWorkdayRoster(cfg, 'tok', null, {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            now,
        });

        expect(state.calls).toBe(WORKDAY_MAX_PAGES_PER_RUN);
        expect(state.calls).toBeGreaterThan(3);
        expect(out.complete).toBe(false);
    });

    it('a deadline already spent still leaves the incoming cursor untouched', async () => {
        // The degenerate end of the range: no page is attempted, so the run
        // makes no progress — but it must not RESET the pass. Handing back
        // anything other than the cursor it was given would make the next run
        // resume from the wrong place, and handing back complete:true would
        // drive the departure reconcile over a roster nobody read.
        const { state, fetchImpl, now } = pagedFetchOnAClock(HUGE_ROSTER, PER_PAGE_MS);

        const out = await readWorkdayRoster(cfg, 'tok', String(WORKDAY_PAGE_SIZE), {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            now,
            readDeadlineAt: 0,
        });

        expect(state.calls).toBe(0);
        expect(out.complete).toBe(false);
        expect(out.resumeToken).toBe(String(WORKDAY_PAGE_SIZE));
    });

    it('a report that ENDED is complete, even when the deadline has passed', async () => {
        // The inversion that would cost a scheduled run for nothing: the short
        // page already proved the report is exhausted, so reporting partial
        // here would store a cursor past the end and defer the departure
        // reconcile by a whole day to rediscover it.
        const SHORT = WORKDAY_PAGE_SIZE - 1;
        const { state, fetchImpl, now } = pagedFetchOnAClock(SHORT, PER_PAGE_MS);

        const out = await readWorkdayRoster(cfg, 'tok', null, {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            now,
            // Spent the instant the first page returns.
            readDeadlineAt: PER_PAGE_MS,
        });

        expect(state.calls).toBe(1);
        expect(out.employees).toHaveLength(SHORT);
        expect(out.complete).toBe(true);
        expect(out.resumeToken).toBeNull();
    });
});

describe('the deadline survives the seams between the usecase and the pages', () => {
    it('the Workday provider forwards it past its own token exchange', async () => {
        // The provider issues an OAuth request BEFORE paging. Recomputing a
        // fresh budget here — or dropping the field while wiring the roster
        // deps — would leave the paging loop unbounded with nothing failing.
        const seen: Array<number | null | undefined> = [];
        const readRoster = jest.fn<ReturnType<typeof readWorkdayRoster>, Parameters<typeof readWorkdayRoster>>(
            async (_cfg, _tok, _resume, deps) => {
                seen.push(deps?.readDeadlineAt);
                return { employees: [], complete: true, resumeToken: null };
            },
        );
        const resolveToken = jest.fn<
            ReturnType<typeof resolveWorkdayAccessToken>,
            Parameters<typeof resolveWorkdayAccessToken>
        >(async (s: WorkdaySecret) => ({ accessToken: s.accessToken || 'fresh', rotated: null }));

        const provider = new WorkdayProvider({ readRoster, resolveToken });
        await provider.listEmployees(
            {
                host: cfg.host,
                tenant: cfg.tenant,
                reportPath: cfg.reportPath,
                clientId: 'cid',
                clientSecret: 'csecret',
                accessToken: 'at',
                refreshToken: 'rt',
                expiresAt: 9_999_999_999,
            },
            null,
            { readDeadlineAt: 1_234_567 },
        );

        expect(readRoster).toHaveBeenCalledTimes(1); // positive control
        expect(seen).toEqual([1_234_567]);
    });

    it('the usecase hands one to the provider, no later than the budget allows', async () => {
        const seen: HrisSyncDeps[] = [];
        const before = Date.now();
        const provider = {
            listEmployees: jest.fn(
                async (
                    _config: Record<string, unknown>,
                    _resumeFrom?: string | null,
                    deps?: HrisSyncDeps,
                ): Promise<ListEmployeesResult> => {
                    seen.push(deps ?? {});
                    return { employees: [] as NormalizedEmployee[], complete: true, resumeToken: null };
                },
            ),
        };

        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', provider });
        const after = Date.now();

        expect(r.status).toBe('PASSED');
        // POSITIVE CONTROL. An empty `seen` satisfies every assertion below by
        // vacuity — this is the empty-selection failure the assertions have to
        // be immune to.
        expect(provider.listEmployees).toHaveBeenCalledTimes(1);
        expect(seen).toHaveLength(1);

        const deadline = seen[0].readDeadlineAt;
        expect(typeof deadline).toBe('number');
        // Bracketed rather than compared to a frozen instant: the usecase
        // measures from its own `Date.now()`, so the only honest claim is that
        // the deadline lands one budget after a moment inside this call. An
        // upper bound alone would pass for a deadline of `now`, and a lower
        // bound alone would pass for one an hour out.
        expect(deadline).toBeGreaterThanOrEqual(before + ROSTER_READ_DEADLINE_MS);
        expect(deadline).toBeLessThanOrEqual(after + ROSTER_READ_DEADLINE_MS);
    });
});
