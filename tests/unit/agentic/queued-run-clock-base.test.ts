import { QUEUED_CLOCK_BASE_MAX_SKEW_MS, queuedRunClockBase } from '@/app-layer/usecases/workflow-runs';

/**
 * WHERE A QUEUED SEGMENT'S `RUNTIME_MS` CLOCK RUNS FROM (#5534).
 *
 * A person's resume of a reasoning run puts `clockBase` in the
 * `agent-run-execute` payload; a start puts none. The value crosses a queue,
 * so the worker reads it through this function, and every value it cannot
 * vouch for falls back to the run's start — the stricter reading, never a
 * longer one. The end-to-end behaviour is
 * `tests/integration/reasoning-resume-clock-base.test.ts`.
 */
const START = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const NOW = START + 3 * HOUR;

describe('queuedRunClockBase', () => {
    it('measures from the resume a person made', () => {
        expect(queuedRunClockBase(NOW - HOUR, START, NOW)).toEqual({ baseMs: NOW - HOUR, source: 'RESUME' });
    });

    it('measures from the run start when the job carries no base (a start)', () => {
        expect(queuedRunClockBase(undefined, START, NOW)).toEqual({ baseMs: START, source: 'RUN_START' });
        expect(queuedRunClockBase(null, START, NOW)).toEqual({ baseMs: START, source: 'RUN_START' });
    });

    it('is a pure function of the payload, so a re-delivery gets the same base', () => {
        // A retry arriving later re-reads the SAME payload; the base does not
        // move with the worker's clock.
        expect(queuedRunClockBase(NOW - HOUR, START, NOW).baseMs).toBe(
            queuedRunClockBase(NOW - HOUR, START, NOW + 2 * HOUR).baseMs,
        );
    });

    it.each([
        ['a string', '1800000000000', 'NOT_A_TIME'],
        ['NaN', Number.NaN, 'NOT_A_TIME'],
        ['Infinity', Number.POSITIVE_INFINITY, 'NOT_A_TIME'],
        ['before the run started', START - 1, 'BEFORE_RUN_START'],
        ['beyond the skew allowance', NOW + QUEUED_CLOCK_BASE_MAX_SKEW_MS + 1, 'IN_THE_FUTURE'],
    ])('ignores %s and falls back to the run start', (_label, value, reason) => {
        expect(queuedRunClockBase(value, START, NOW)).toEqual({ baseMs: START, source: 'RUN_START', ignored: reason });
    });

    it('clamps a base inside the skew allowance to now, so skew buys no time', () => {
        expect(queuedRunClockBase(NOW + 1_000, START, NOW)).toEqual({ baseMs: NOW, source: 'RESUME' });
    });

    it('never returns a base later than now', () => {
        for (const base of [START, NOW - 1, NOW, NOW + 1, NOW + QUEUED_CLOCK_BASE_MAX_SKEW_MS, NOW + 10 * HOUR]) {
            expect(queuedRunClockBase(base, START, NOW).baseMs).toBeLessThanOrEqual(NOW);
        }
    });
});
