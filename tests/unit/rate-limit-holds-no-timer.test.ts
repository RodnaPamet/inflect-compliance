/**
 * THE IN-MEMORY LIMITER HOLDS NO TIMER, AND SWEEPS EACH KEY BY ITS OWN WINDOW (#4613).
 *
 * `src/lib/security/rate-limit.ts` used to start a five-minute `setInterval` the
 * first time any limiter function ran, and never clear it. Under Jest's in-band
 * runner every test file gets its own copy of the module, so every file that
 * touched the limiter left an interval behind, and the interval's callback kept
 * that file's whole module graph alive until the shard ended. Heap snapshots
 * traced retained test contexts to `TimersList[300000] → Timeout → _onTimeout`.
 *
 * The interval also swept every key with the window of whichever caller started
 * it. A one-minute preset that ran first trimmed a one-hour login-failure
 * history to its last minute, so a lockout counted over an hour was forgotten
 * after five minutes.
 *
 * Each case below fails against the interval implementation.
 */
import {
    checkRateLimit,
    clearAllRateLimits,
    evaluateProgressiveRateLimit,
    rateLimitKeyCount,
    recordProgressiveFailure,
    LOGIN_PROGRESSIVE_POLICY,
    type RateLimitConfig,
} from '@/lib/security/rate-limit';

const ONE_MINUTE: RateLimitConfig = { maxAttempts: 100, windowMs: 60_000 };
const SIX_MINUTES_MS = 6 * 60 * 1000;

describe('in-memory rate limiter — no timer, per-key sweep', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        clearAllRateLimits();
    });
    afterEach(() => {
        clearAllRateLimits();
        jest.useRealTimers();
    });

    it('schedules no timer, whichever limiter function runs', () => {
        checkRateLimit('k:check', ONE_MINUTE);
        evaluateProgressiveRateLimit('k:evaluate', LOGIN_PROGRESSIVE_POLICY);
        recordProgressiveFailure('k:record', LOGIN_PROGRESSIVE_POLICY);

        // A pending timer is what kept each test file's module graph alive.
        expect(jest.getTimerCount()).toBe(0);
    });

    it('keeps a one-hour login lockout through a sweep started by a one-minute key', () => {
        // The one-minute key runs FIRST: the interval took its window for
        // every key it swept.
        checkRateLimit('k:short', ONE_MINUTE);
        for (let i = 0; i < LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures; i += 1) {
            recordProgressiveFailure('k:login', LOGIN_PROGRESSIVE_POLICY);
        }
        expect(evaluateProgressiveRateLimit('k:login', LOGIN_PROGRESSIVE_POLICY).allowed).toBe(false);

        // Past one sweep interval, inside both the hour window and the
        // fifteen-minute lockout. Another key's turn runs the sweep.
        jest.advanceTimersByTime(SIX_MINUTES_MS);
        checkRateLimit('k:other', ONE_MINUTE);

        const decision = evaluateProgressiveRateLimit('k:login', LOGIN_PROGRESSIVE_POLICY);
        expect(decision.failureCount).toBe(LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures);
        expect(decision.allowed).toBe(false);
    });

    it('drops keys with nothing left inside their window, on a later caller’s turn', () => {
        checkRateLimit('k:a', ONE_MINUTE);
        checkRateLimit('k:b', ONE_MINUTE);
        expect(rateLimitKeyCount()).toBe(2);

        jest.advanceTimersByTime(SIX_MINUTES_MS);
        checkRateLimit('k:c', ONE_MINUTE);

        // a and b are stale and gone; c was just written.
        expect(rateLimitKeyCount()).toBe(1);
    });

    it('sweeps at most once per interval, so a key just written survives', () => {
        checkRateLimit('k:a', ONE_MINUTE);
        jest.advanceTimersByTime(SIX_MINUTES_MS);
        checkRateLimit('k:b', ONE_MINUTE); // sweeps a
        jest.advanceTimersByTime(2 * 60 * 1000); // b is now stale, but the interval has not passed
        checkRateLimit('k:c', ONE_MINUTE);

        expect(rateLimitKeyCount()).toBe(2);
    });
});
