/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring a
 * Prisma transaction client. Per-line typing has poor cost/benefit in test
 * doubles; the file-level disable is this repo's standard for the shape. */
/**
 * The baseline figures the circuit-breaker panel reports, and the population
 * they are counted over.
 *
 * `getAgentCircuitBreaker` returns two things that have to agree: a `baseline`
 * block, and `lookbackWindows: BASELINE_WINDOW_LIMIT` sitting beside it saying
 * how far back those figures reach. They did not agree — `accepted` was
 * filtered from the SAME 48-row ledger page the payload returns, so the count
 * saturated at 48 for every agent past its first two days and the payload
 * advertised a 168-window look-back it had never performed.
 *
 * What is asserted here is the POPULATION, not the arithmetic: that the figures
 * are the population `evaluateWindow` reads (since the epoch, capped at
 * `BASELINE_WINDOW_LIMIT`, the hour still filling and the window awaiting a
 * verdict excluded, anomalous dropped afterwards) and NOT the page.
 *
 * The population is not asserted against a re-implementation of it. It is
 * asserted against `evaluateCircuitBreaker` — the real detector — fed the same
 * fixture rows the way `evaluateWindow` assembles them (`detectorBaselineAt`
 * below). A test that recomputed the expected count with its own slice would
 * agree with the usecase and with nothing else; two independent readings of the
 * same rows landing on the same number is the only evidence that "counted the
 * way the detector counts" is a fact rather than a sentence.
 *
 * The fake client honours `where.windowStart`, `orderBy` and `take` because
 * every assertion below is about exactly those three: a double that ignored
 * `take` would report a fix that is not there.
 *
 * The clock is FROZEN. The fixture is built from `windowStartFor(now)` and the
 * usecase reads a clock of its own; an hour rollover between the two moves the
 * whole population by one row.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

import { getAgentCircuitBreaker } from '@/app-layer/usecases/agent-circuit-breaker';
import { runInTenantContext } from '@/lib/db-context';
import {
    BASELINE_WINDOW_LIMIT,
    MIN_BASELINE_WINDOWS,
    WINDOW_MS,
    evaluateCircuitBreaker,
    windowKeyFor,
    windowStartFor,
    type BreakerObservation,
} from '@/lib/agentic/circuit-breaker';
import { makeRequestContext } from '../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;
const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'user-1' });

/** How many rows the ledger page carries — `WINDOW_PAGE` in the usecase. */
const PAGE = 48;

/** Frozen mid-hour, so `windowStartFor` has something to truncate. */
const NOW = new Date('2026-09-10T14:37:11.000Z');
const CURRENT_START = windowStartFor(NOW);

interface Row {
    windowStart: Date;
    readCalls: number;
    proposeCalls: number;
    orchestrateCalls: number;
    toolNames: string[];
    anomalous: boolean;
    verdict: string | null;
}

const calls = (r: Row): number => r.readCalls + r.proposeCalls + r.orchestrateCalls;
const sumCalls = (rows: Row[]): number => rows.reduce((t, r) => t + calls(r), 0);

/**
 * `count` complete windows, newest ending in the hour before this one, plus the
 * hour still filling at index 0. Every `anomalousEvery`-th complete window is
 * flagged, so the anomalous rows are spread through the look-back rather than
 * bunched at one end where a slice bug could miss them.
 */
function makeWindows(count: number, anomalousEvery = 7): Row[] {
    const rows: Row[] = [];
    for (let i = 1; i <= count; i++) {
        rows.push({
            windowStart: new Date(CURRENT_START.getTime() - i * WINDOW_MS),
            // Distinct per window, so a sum over the wrong population lands on
            // a different number rather than a coincidentally equal one.
            readCalls: 3 + (i % 5),
            proposeCalls: i % 3,
            orchestrateCalls: i % 2,
            toolNames: ['agent.framework_status'],
            anomalous: i % anomalousEvery === 0,
            verdict: 'STEADY',
        });
    }
    // The hour still filling: newest of all, partial by definition.
    const filling: Row = {
        windowStart: new Date(CURRENT_START),
        readCalls: 2,
        proposeCalls: 0,
        orchestrateCalls: 0,
        toolNames: ['agent.framework_status'],
        anomalous: false,
        verdict: null,
    };
    return [filling, ...rows];
}

const toObservation = (r: Row): BreakerObservation => ({
    windowKey: windowKeyFor(r.windowStart),
    readCalls: r.readCalls,
    proposeCalls: r.proposeCalls,
    orchestrateCalls: r.orchestrateCalls,
    toolNames: r.toolNames,
    anomalous: r.anomalous,
});

/**
 * What the REAL detector's baseline reading would be if it judged at `at`.
 *
 * A transcription of `evaluateWindow` (circuit-breaker-store.ts) and nothing
 * else: rows in `[epoch, windowStartFor(at))`, newest first, the newest
 * `BASELINE_WINDOW_LIMIT + 1` of them, `rows[0]` judged and `rows.slice(1)`
 * handed to `evaluateCircuitBreaker` — which drops the anomalous ones itself.
 * The numbers come back out of the detector, not out of this helper.
 */
function detectorBaselineAt(rows: Row[], at: Date, epoch?: Date) {
    const start = windowStartFor(at);
    const inRange = rows
        .filter(
            (r) => r.windowStart < start && (epoch === undefined || r.windowStart >= epoch),
        )
        .sort((a, b) => b.windowStart.getTime() - a.windowStart.getTime())
        .slice(0, BASELINE_WINDOW_LIMIT + 1);
    const judged = inRange[0];
    if (judged === undefined) throw new Error('fixture has no complete window to judge');
    const verdict = evaluateCircuitBreaker({
        now: at,
        current: toObservation(judged),
        baseline: inRange.slice(1).map(toObservation),
        // Not a signal under test — the rejection half is judged from
        // `AgentActionProposal`, which this panel does not read.
        rejection: {
            recentReviewed: 0,
            recentRejected: 0,
            baselineReviewed: 0,
            baselineRejected: 0,
        },
        priorStreak: 0,
        priorStreakSignals: [],
    });
    return { judged, code: verdict.code, ...verdict.baseline };
}

interface DbOptions {
    rows: Row[];
    /** The breaker row, or `null` for an agent nothing has ever judged. */
    breaker?: { baselineEpoch: Date; state: string; lastEvaluatedWindow: string | null } | null;
    /**
     * Hand rows back OLDEST-first instead of newest-first.
     *
     * The store orders `windowStart: 'desc'` today, which makes the last element
     * of every page the oldest one — so a usecase that read either end would
     * agree with one that takes a minimum, and no fixture could tell them apart.
     * This inverts the seam the usecase actually reads, which is the only place
     * the ordering can be varied: `rows` is re-sorted here, so passing a
     * reversed array would not have reached it.
     */
    ascending?: boolean;
}

function makeDb({ rows, breaker = null, ascending = false }: DbOptions) {
    const windowQueries: any[] = [];
    const db = {
        registeredAgent: {
            findFirst: jest.fn(async () => ({
                id: 'agent-1',
                name: 'Agent one',
                riskTier: 'LOW',
            })),
        },
        agentCircuitBreaker: {
            findUnique: jest.fn(async () => breaker),
        },
        agentBehaviourWindow: {
            findMany: jest.fn(async (args: any) => {
                windowQueries.push(args);
                const bound = args.where?.windowStart ?? {};
                const matched = rows
                    .filter(
                        (r) =>
                            (bound.gte === undefined || r.windowStart >= bound.gte) &&
                            (bound.lt === undefined || r.windowStart < bound.lt),
                    )
                    .sort((a, b) => b.windowStart.getTime() - a.windowStart.getTime());
                // The `take` is applied to the NEWEST-first order either way —
                // that is the row cap the store performs. Only the order the
                // capped page is handed back in changes, so `ascending` varies
                // the ordering without also varying the population.
                const page = args.take === undefined ? matched : matched.slice(0, args.take);
                return (ascending ? [...page].reverse() : page).map((r) => ({ ...r }));
            }),
        },
    };
    mockRunInTx.mockImplementation(async (_ctx: any, fn: any) => fn(db));
    return { db, windowQueries };
}

/** A breaker that has NOT judged the current hour yet — the ordinary state. */
const NOT_YET_JUDGED = {
    baselineEpoch: new Date(CURRENT_START.getTime() - 5000 * WINDOW_MS),
    state: 'CLOSED',
    lastEvaluatedWindow: windowKeyFor(new Date(CURRENT_START.getTime() - WINDOW_MS)),
};

beforeAll(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'] });
});

afterAll(() => {
    jest.useRealTimers();
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe('the baseline block is the detector population, not the page', () => {
    it('counts past the page size, up to the look-back limit', async () => {
        // 200 complete windows: more than the look-back, so the cap is what
        // stops the count rather than the fixture running out.
        const rows = makeWindows(200);
        makeDb({ rows });

        const view = await getAgentCircuitBreaker(ctx, 'agent-1');
        const detector = detectorBaselineAt(rows, NOW);

        expect(view.baseline.windows).toBe(detector.windows);
        expect(view.baseline.observations).toBe(detector.observations);
        // The negative the defect made true — the figure could never exceed the
        // page — with the positive that says what it is instead.
        expect(view.baseline.windows).toBeGreaterThan(PAGE);
        // And the payload's own claim about its reach is now the population it
        // used: the count is bounded BY the advertised look-back.
        expect(view.baseline.windows).toBeLessThanOrEqual(view.baseline.lookbackWindows);
        expect(view.baseline.lookbackWindows).toBe(BASELINE_WINDOW_LIMIT);

        // The ledger page is unchanged — it is a page of recent activity and
        // was never the thing that was wrong.
        expect(view.windows).toHaveLength(PAGE);
    });

    it('excludes the anomalous windows the detector drops, and nothing else', async () => {
        const rows = makeWindows(200);
        makeDb({ rows });

        const view = await getAgentCircuitBreaker(ctx, 'agent-1');

        // A real exclusion, not a vacuous one: the fixture HAS anomalous rows
        // inside the look-back, and the detector's own reading is what says how
        // many survive. `+ 2` is the filling hour plus the judged window.
        const inLookback = rows.slice(2, BASELINE_WINDOW_LIMIT + 2);
        const anomalous = inLookback.filter((r) => r.anomalous);
        expect(anomalous.length).toBeGreaterThan(0);
        expect(view.baseline.windows).toBe(inLookback.length - anomalous.length);
        expect(view.baseline.windows).toBe(detectorBaselineAt(rows, NOW).windows);
    });

    it('excludes the window still filling, which stays in the ledger page', async () => {
        // A short history and none anomalous, so the population is small enough
        // that one extra row moves the count: with the still-filling hour
        // counted this reports one window and 2 observations more.
        const rows = makeWindows(12, Number.MAX_SAFE_INTEGER);
        makeDb({ rows });

        const view = await getAgentCircuitBreaker(ctx, 'agent-1');
        const detector = detectorBaselineAt(rows, NOW);

        expect(view.baseline.windows).toBe(detector.windows);
        expect(view.baseline.observations).toBe(detector.observations);
        // Present in the ledger, and named as the filling hour so the client can
        // label it rather than counting it.
        expect(view.windows[0].windowStart).toEqual(rows[0].windowStart);
        expect(view.currentWindowStart).toEqual(rows[0].windowStart);
        expect(view.baseline.observations).toBeLessThan(sumCalls(rows.slice(1)));
    });

    it('excludes the window awaiting a verdict, which is what the detector judges', async () => {
        // The reassurance case, at the exact threshold. TWELVE complete windows
        // and `MIN_BASELINE_WINDOWS` is 12 — so a panel that counted all of
        // them would report "12 of 12", the operator's cue that the agent is
        // being judged, while the detector's very next verdict is NO_BASELINE:
        // it judges the newest complete window and no window is part of the
        // baseline it is judged against (`rows.slice(1)`).
        const rows = makeWindows(MIN_BASELINE_WINDOWS, Number.MAX_SAFE_INTEGER);
        makeDb({ rows, breaker: NOT_YET_JUDGED });

        const view = await getAgentCircuitBreaker(ctx, 'agent-1');
        const detector = detectorBaselineAt(rows, NOW, NOT_YET_JUDGED.baselineEpoch);

        expect(detector.code).toBe('NO_BASELINE');
        expect(detector.sufficient).toBe(false);
        expect(view.baseline.windows).toBe(detector.windows);
        expect(view.baseline.windows).toBe(MIN_BASELINE_WINDOWS - 1);
        // The claim that matters: the panel does NOT report the thresholds met
        // where the detector refuses to judge.
        expect(view.baseline.windows).toBeLessThan(view.baseline.requiredWindows);
        // And the row it left out is named, so the ledger can label it rather
        // than showing a Counted row the figures do not include.
        expect(view.pendingVerdictWindowStart).toEqual(detector.judged.windowStart);
        expect(view.pendingVerdictWindowStart).toEqual(rows[1].windowStart);
    });

    it('agrees with the detector on the window that clears the threshold', async () => {
        // One more complete window than above. The positive companion: the test
        // before it must not be passing because this panel always undercounts.
        const rows = makeWindows(MIN_BASELINE_WINDOWS + 1, Number.MAX_SAFE_INTEGER);
        makeDb({ rows, breaker: NOT_YET_JUDGED });

        const view = await getAgentCircuitBreaker(ctx, 'agent-1');
        const detector = detectorBaselineAt(rows, NOW, NOT_YET_JUDGED.baselineEpoch);

        expect(detector.sufficient).toBe(true);
        expect(detector.code).not.toBe('NO_BASELINE');
        expect(view.baseline.windows).toBe(detector.windows);
        expect(view.baseline.windows).toBe(MIN_BASELINE_WINDOWS);
        expect(view.baseline.windows).toBeGreaterThanOrEqual(view.baseline.requiredWindows);
        expect(view.baseline.observations).toBeGreaterThanOrEqual(
            view.baseline.requiredObservations,
        );
    });

    it('counts the newest complete window once this hour has already been judged', async () => {
        // `evaluateWindow` judges at most once per window and refuses on
        // `lastEvaluatedWindow === currentKey`. Once that verdict has landed
        // nothing more happens until the hour turns, and by then the row it
        // judged HAS joined the baseline — so excluding it here would understate
        // an actively-judged agent by one and print "awaiting its verdict" on a
        // row already showing the verdict it got.
        const rows = makeWindows(MIN_BASELINE_WINDOWS, Number.MAX_SAFE_INTEGER);
        const breaker = { ...NOT_YET_JUDGED, lastEvaluatedWindow: windowKeyFor(NOW) };
        makeDb({ rows, breaker });

        const view = await getAgentCircuitBreaker(ctx, 'agent-1');
        // The next judgement this breaker can make is in the NEXT hour, which
        // is the instant the detector reading has to be taken at.
        const nextHour = new Date(NOW.getTime() + WINDOW_MS);
        const detector = detectorBaselineAt(rows, nextHour, breaker.baselineEpoch);

        expect(view.baseline.windows).toBe(detector.windows);
        expect(view.baseline.windows).toBe(MIN_BASELINE_WINDOWS);
        expect(view.baseline.observations).toBe(detector.observations);
        // Nothing is awaiting a verdict, so no row is labelled as if it were.
        expect(view.pendingVerdictWindowStart).toBeNull();
    });

    it('discards history from before the epoch a re-baseline set', async () => {
        const rows = makeWindows(200, Number.MAX_SAFE_INTEGER);
        // An epoch twenty complete windows back: everything older was discarded
        // by an ACCEPTED_NEW_BASELINE close and must not be counted again.
        const epoch = rows[20].windowStart;
        makeDb({ rows, breaker: { ...NOT_YET_JUDGED, baselineEpoch: epoch } });

        const view = await getAgentCircuitBreaker(ctx, 'agent-1');
        const detector = detectorBaselineAt(rows, NOW, epoch);

        expect(view.baseline.windows).toBe(detector.windows);
        expect(view.baseline.observations).toBe(detector.observations);
        // The positive companion: the discarded rows are real and still
        // readable — the page shows them, the baseline does not count them.
        expect(detector.windows).toBeLessThan(rows.length - 1);
        expect(view.windows.length).toBe(PAGE);
    });

    it('reads the ledger twice however long the history is', async () => {
        const { windowQueries } = makeDb({ rows: makeWindows(200) });

        await getAgentCircuitBreaker(ctx, 'agent-1');

        // One page + one look-back, both bounded. A per-window read here would
        // be the N+1 the query-shape guardrail exists to stop, and an unbounded
        // look-back read would put a whole agent's history in memory.
        expect(windowQueries).toHaveLength(2);
        // `+ 1` is the judged window, exactly as `evaluateWindow` takes it: 168
        // baseline rows plus the row they are the baseline FOR.
        expect(windowQueries.map((q) => q.take).sort((a, b) => a - b)).toEqual([
            PAGE,
            BASELINE_WINDOW_LIMIT + 1,
        ]);
    });
});

/**
 * The baseline's REACH, which its count cannot express (#2461).
 *
 * `windows` counts ACTIVE hours. Two agents can hand the panel an identical
 * "12 of 12" while one was observed over twelve consecutive hours and the other
 * over twelve days, and until these fields existed the surface could not tell
 * them apart — so an operator challenging a trip had no way to see that the
 * history it was judged against began a quarter ago.
 *
 * The fixtures below are deliberately built to hold the COUNT fixed and vary
 * only the spacing. A contiguous fixture would make span and count numerically
 * equal, and every assertion here would pass against an implementation that
 * simply returned `accepted.length` — the defect this file exists to catch.
 */
describe('the baseline reports how far back it reaches, not just how much', () => {
    /** `count` complete windows spaced `everyHours` apart, plus the filling hour. */
    function makeSparseWindows(count: number, everyHours: number): Row[] {
        const rows: Row[] = [];
        for (let i = 1; i <= count; i++) {
            rows.push({
                windowStart: new Date(CURRENT_START.getTime() - i * everyHours * WINDOW_MS),
                readCalls: 3 + (i % 5),
                proposeCalls: i % 3,
                orchestrateCalls: i % 2,
                toolNames: ['agent.framework_status'],
                anomalous: false,
                verdict: 'STEADY',
            });
        }
        const filling: Row = {
            windowStart: new Date(CURRENT_START),
            readCalls: 2,
            proposeCalls: 0,
            orchestrateCalls: 0,
            toolNames: ['agent.framework_status'],
            anomalous: false,
            verdict: null,
        };
        return [filling, ...rows];
    }

    it('separates twelve consecutive hours from twelve days, at the same count', async () => {
        makeDb({ rows: makeWindows(12, 99) });
        const consecutive = await getAgentCircuitBreaker(ctx, 'agent-1');

        jest.clearAllMocks();
        makeDb({ rows: makeSparseWindows(12, 24) });
        const intermittent = await getAgentCircuitBreaker(ctx, 'agent-1');

        // The premise: the counts are IDENTICAL, so nothing below can be
        // explained by one baseline simply having more in it. Eleven and not
        // twelve because the newest complete window is the one AWAITING a
        // verdict — it is the subject of the next judgement, so it is not part
        // of the baseline that judgement reads.
        expect(consecutive.baseline.windows).toBe(11);
        expect(intermittent.baseline.windows).toBe(consecutive.baseline.windows);

        // And the reach is not: one week-day of history against twelve days.
        expect(consecutive.baseline.spanHours).toBe(12);
        expect(intermittent.baseline.spanHours).toBe(288);

        // Stated as the relationship, because THIS is the claim: an
        // implementation returning the count would satisfy the consecutive
        // case and fail here.
        expect(intermittent.baseline.spanHours).toBeGreaterThan(
            intermittent.baseline.windows,
        );
    });

    it('reports the oldest accepted window as an instant, not a count', async () => {
        const rows = makeSparseWindows(12, 24);
        makeDb({ rows });

        const view = await getAgentCircuitBreaker(ctx, 'agent-1');

        const oldest = rows
            .map((r) => r.windowStart)
            .reduce((a, b) => (a < b ? a : b));
        expect(view.baseline.oldestWindowStart).toEqual(
            new Date(CURRENT_START.getTime() - 12 * 24 * WINDOW_MS),
        );
        // The filling hour is NOT the oldest, but it IS in `rows` — so this
        // also witnesses that the reduce ran over the accepted population and
        // not over the raw ledger page.
        expect(view.baseline.oldestWindowStart).toEqual(oldest);
        expect(view.baseline.spanHours).toBe(288);
    });

    it('reports null — not zero — when nothing has been accepted', async () => {
        // Only the hour still filling, which is excluded from the baseline. The
        // accepted population is empty.
        makeDb({ rows: makeWindows(0) });

        const view = await getAgentCircuitBreaker(ctx, 'agent-1');

        expect(view.baseline.windows).toBe(0);
        // Zero here would read on the panel as "gathered just now", which is
        // the opposite of the truth.
        expect(view.baseline.oldestWindowStart).toBeNull();
        expect(view.baseline.spanHours).toBeNull();
    });

    it('picks the oldest ACCEPTED window by value, not by position in the page', async () => {
        // MUTATION-PROVING GAP, closed here. The reach is taken as a MINIMUM
        // over `accepted` rather than off an end, and the usecase says so — but
        // until this test every fixture arrived newest-first, so the last
        // element WAS the oldest and `accepted[accepted.length - 1]` satisfied
        // all four cases above. The claim had no assertion behind it.
        //
        // READ THE SCOPE CAREFULLY, because a wider version of this test is
        // wrong and was written first: `getAgentCircuitBreaker` as a whole is
        // NOT order-agnostic and does not claim to be. `accepted` is
        // `lookback.slice(1)` while a verdict is pending, which drops the newest
        // complete window — the one awaiting judgement — and that is correct
        // ONLY on a newest-first page. Handing the whole function a reversed
        // page drops the OLDEST window instead and the reach moves by a day,
        // which is the slice failing, not the reduce.
        //
        // So this pins the narrow claim the new code actually makes, on the
        // branch where the slice cannot confound it: once this hour HAS been
        // judged, `accepted` is `slice(0, BASELINE_WINDOW_LIMIT)` over a
        // 12-row page, which is every row in either order. Same population,
        // different order — the only thing varying is what the reduce sees.
        const rows = makeSparseWindows(12, 24);
        const breaker = { ...NOT_YET_JUDGED, lastEvaluatedWindow: windowKeyFor(NOW) };
        makeDb({ rows, breaker, ascending: true });

        const view = await getAgentCircuitBreaker(ctx, 'agent-1');

        // The premise: the reversal did not change WHICH windows were accepted.
        // Without this the assertion below could be satisfied by a page that
        // lost rows, which is the failure mode of the wider test described above.
        expect(view.baseline.windows).toBe(12);
        // Oldest-first input, and the oldest window is still the oldest one.
        expect(view.baseline.oldestWindowStart).toEqual(
            new Date(CURRENT_START.getTime() - 12 * 24 * WINDOW_MS),
        );
        expect(view.baseline.spanHours).toBe(288);
    });

    it('excludes anomalous windows from the reach, as it does from the count', async () => {
        // The OLDEST window is anomalous, so a reach computed over the raw page
        // would reach further back than the detector ever reads.
        const rows = makeSparseWindows(6, 24);
        rows[rows.length - 1].anomalous = true;

        makeDb({ rows });
        const view = await getAgentCircuitBreaker(ctx, 'agent-1');

        // Six fixture windows, less the one awaiting a verdict, less the
        // anomalous one the detector drops.
        expect(view.baseline.windows).toBe(4);
        // 120 hours and not 144: the dropped row was the OLDEST, so a reach
        // computed over the raw page would have reached a day further back
        // than the detector ever reads.
        expect(view.baseline.spanHours).toBe(120);
        expect(view.baseline.oldestWindowStart).toEqual(
            new Date(CURRENT_START.getTime() - 5 * 24 * WINDOW_MS),
        );
    });
});
