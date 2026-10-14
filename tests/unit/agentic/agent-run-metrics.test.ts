/**
 * #3484 — the agentic run metrics, at the seam that emits them.
 *
 * The claims worth holding are not "a counter exists". They are the three
 * decisions that make the numbers mean something:
 *
 *   1. ONE SEAM, BOTH ENGINES. The static driver and Flue each settle their
 *      own runs, so a counter per driver would be the same call at six sites
 *      and the seventh would be the one somebody forgot.
 *   2. STARTED AND SETTLED MUST BALANCE. A started run that throws past the
 *      walk still has to be counted as settled, or the gap reads as a leak.
 *   3. A PAUSE IS NOT A SETTLEMENT. Counting AWAITING_APPROVAL as settled
 *      would make the outstanding-run figure read zero while a queue of them
 *      waited on people.
 */
import {
    recordAgentRunStarted,
    recordAgentRunSettled,
    recordAgentGuardBlock,
    startAgentRunsInFlightReporting,
    _resetAgentRunsInFlightGaugeForTesting,
} from '@/lib/observability/metrics';

const add = jest.fn();
const record = jest.fn();
const addCallback = jest.fn();

jest.mock('@opentelemetry/api', () => {
    const actual = jest.requireActual('@opentelemetry/api');
    return {
        ...actual,
        metrics: {
            getMeter: () => ({
                createCounter: (name: string) => ({
                    add: (v: number, labels: unknown) => add(name, v, labels),
                }),
                createHistogram: (name: string) => ({
                    record: (v: number, labels: unknown) => record(name, v, labels),
                }),
                createObservableGauge: (name: string) => ({
                    addCallback: (cb: unknown) => addCallback(name, cb),
                }),
            }),
        },
    };
});

beforeEach(() => {
    jest.clearAllMocks();
    _resetAgentRunsInFlightGaugeForTesting();
});

describe('run counters', () => {
    it('labels a start with the engine that ran it, and nothing else', () => {
        recordAgentRunStarted({ driver: 'FLUE' });
        expect(add).toHaveBeenCalledWith('agent.run.started', 1, { 'agent.driver': 'FLUE' });
        // NO TENANT LABEL. This module's own rule for the repository metrics:
        // a tenant label multiplies every series by the customer count, and
        // span attributes are where tenant-aware debugging belongs.
        const labels = add.mock.calls[0][2] as Record<string, unknown>;
        expect(Object.keys(labels)).toEqual(['agent.driver']);
    });

    it('settles through ONE counter with an outcome label, not three counters', () => {
        // Three counters would let a dashboard compute a completion RATE only
        // by knowing all three names, and would make a fourth outcome a code
        // change rather than a new label value.
        for (const outcome of ['completed', 'failed', 'aborted'] as const) {
            recordAgentRunSettled({ driver: 'STATIC', outcome });
        }
        const names = add.mock.calls.map((c) => c[0]);
        expect(new Set(names)).toEqual(new Set(['agent.run.settled']));
        expect(add.mock.calls.map((c) => (c[2] as { outcome: string }).outcome)).toEqual([
            'completed', 'failed', 'aborted',
        ]);
    });

    it('records the step and token histograms ONCE per run', () => {
        recordAgentRunSettled({ driver: 'FLUE', outcome: 'completed', steps: 7, tokens: 1234 });
        expect(record).toHaveBeenCalledWith('agent.run.steps', 7, expect.anything());
        expect(record).toHaveBeenCalledWith('agent.run.tokens', 1234, expect.anything());
        expect(record).toHaveBeenCalledTimes(2);
    });

    it('OMITS an unknown figure rather than recording zero', () => {
        // A run whose token usage the engine never reported and a run that
        // genuinely spent nothing are different facts, and zero in a histogram
        // is an observation that drags the distribution down.
        recordAgentRunSettled({ driver: 'FLUE', outcome: 'completed', steps: 3, tokens: null });
        expect(record).toHaveBeenCalledWith('agent.run.steps', 3, expect.anything());
        expect(record).toHaveBeenCalledTimes(1);
    });

    it('records a genuine ZERO, because that is a measurement', () => {
        recordAgentRunSettled({ driver: 'STATIC', outcome: 'completed', steps: 0, tokens: 0 });
        expect(record).toHaveBeenCalledWith('agent.run.steps', 0, expect.anything());
        expect(record).toHaveBeenCalledWith('agent.run.tokens', 0, expect.anything());
    });
});

describe('the guard-block counter', () => {
    it('keeps QUARANTINED and FLAGGED apart on one counter', () => {
        recordAgentGuardBlock({ verdict: 'QUARANTINED' });
        recordAgentGuardBlock({ verdict: 'FLAGGED' });
        expect(add.mock.calls.map((c) => c[2])).toEqual([
            { 'guard.verdict': 'QUARANTINED' },
            { 'guard.verdict': 'FLAGGED' },
        ]);
    });
});

describe('the runs-in-flight gauge', () => {
    it('observes the registry it was given', () => {
        let size = 3;
        startAgentRunsInFlightReporting(() => size);
        const cb = addCallback.mock.calls[0][1] as (r: { observe: (n: number) => void }) => void;
        const observe = jest.fn();
        cb({ observe });
        expect(observe).toHaveBeenCalledWith(3);
        // …and it reads LIVE, not at registration: a gauge that captured the
        // value once would report the count at process start forever.
        size = 5;
        cb({ observe });
        expect(observe).toHaveBeenLastCalledWith(5);
    });

    it('is idempotent — a second start does not register a second callback', () => {
        startAgentRunsInFlightReporting(() => 1);
        startAgentRunsInFlightReporting(() => 2);
        expect(addCallback).toHaveBeenCalledTimes(1);
    });

    it('a throwing source costs this series and NOT the whole export', () => {
        // Every instrument in the batch shares the scrape. A callback that
        // threw would take the others with it.
        startAgentRunsInFlightReporting(() => {
            throw new Error('registry unavailable');
        });
        const cb = addCallback.mock.calls[0][1] as (r: { observe: (n: number) => void }) => void;
        expect(() => cb({ observe: jest.fn() })).not.toThrow();
    });
});
