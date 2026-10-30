/**
 * Unit Test: Epic A.3 progressive rate-limit primitive.
 *
 * Pins the three-tier escalation contract from LOGIN_PROGRESSIVE_POLICY:
 *   1 — 2 failures:  no delay
 *   3 — 4 failures:  5s delay
 *   5 — 9 failures:  30s delay
 *   10 failures:     hard lockout (15 min)
 *
 * Plus:
 *   - reset clears the counter (success path)
 *   - lockout auto-expires and then permits the next attempt with zero delay
 *   - failures older than windowMs age out
 *   - concurrent keys are independent
 */

import {
    evaluateProgressiveRateLimit,
    recordProgressiveFailure,
    resetProgressiveFailures,
    clearAllRateLimits,
    LOGIN_PROGRESSIVE_POLICY,
    type ProgressiveRateLimitPolicy,
} from '@/lib/security/rate-limit';

describe('Progressive rate-limit primitive', () => {
    beforeEach(() => {
        clearAllRateLimits();
    });

    describe('LOGIN_PROGRESSIVE_POLICY tiers', () => {
        it('no delay for the first 2 failures', () => {
            const k = 'user-a';
            // Pre-check before any failure: zero.
            expect(evaluateProgressiveRateLimit(k, LOGIN_PROGRESSIVE_POLICY)).toMatchObject({
                allowed: true,
                delayMs: 0,
                failureCount: 0,
            });
            // After 1 failure.
            expect(recordProgressiveFailure(k, LOGIN_PROGRESSIVE_POLICY)).toMatchObject({
                allowed: true,
                delayMs: 0,
                failureCount: 1,
            });
            // After 2 failures.
            expect(recordProgressiveFailure(k, LOGIN_PROGRESSIVE_POLICY)).toMatchObject({
                allowed: true,
                delayMs: 0,
                failureCount: 2,
            });
        });

        it('applies 5s delay after the 3rd failure', () => {
            const k = 'user-b';
            for (let i = 0; i < 3; i++) {
                recordProgressiveFailure(k, LOGIN_PROGRESSIVE_POLICY);
            }
            const decision = evaluateProgressiveRateLimit(
                k,
                LOGIN_PROGRESSIVE_POLICY,
            );
            expect(decision.allowed).toBe(true);
            expect(decision.delayMs).toBe(5_000);
            expect(decision.failureCount).toBe(3);
        });

        it('still 5s at 4 failures (tier 1 covers 3–4)', () => {
            const k = 'user-c';
            for (let i = 0; i < 4; i++) {
                recordProgressiveFailure(k, LOGIN_PROGRESSIVE_POLICY);
            }
            expect(
                evaluateProgressiveRateLimit(k, LOGIN_PROGRESSIVE_POLICY).delayMs,
            ).toBe(5_000);
        });

        it('escalates to 30s at 5 failures', () => {
            const k = 'user-d';
            for (let i = 0; i < 5; i++) {
                recordProgressiveFailure(k, LOGIN_PROGRESSIVE_POLICY);
            }
            expect(
                evaluateProgressiveRateLimit(k, LOGIN_PROGRESSIVE_POLICY).delayMs,
            ).toBe(30_000);
        });

        it.each([5, 6, 7, 8, 9])(
            'stays at 30s through failure %i',
            (count) => {
                const k = `user-${count}`;
                for (let i = 0; i < count; i++) {
                    recordProgressiveFailure(k, LOGIN_PROGRESSIVE_POLICY);
                }
                expect(
                    evaluateProgressiveRateLimit(k, LOGIN_PROGRESSIVE_POLICY)
                        .delayMs,
                ).toBe(30_000);
            },
        );

        it('locks out at 10 failures with retryAfterSeconds ≥ 1', () => {
            const k = 'user-locked';
            for (let i = 0; i < 10; i++) {
                recordProgressiveFailure(k, LOGIN_PROGRESSIVE_POLICY);
            }
            const decision = evaluateProgressiveRateLimit(
                k,
                LOGIN_PROGRESSIVE_POLICY,
            );
            expect(decision.allowed).toBe(false);
            expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
            expect(decision.failureCount).toBe(10);
        });

        it('reports retryAfterSeconds ≤ lockoutMs in seconds (15 * 60)', () => {
            const k = 'user-locked-duration';
            for (let i = 0; i < 10; i++) {
                recordProgressiveFailure(k, LOGIN_PROGRESSIVE_POLICY);
            }
            const decision = evaluateProgressiveRateLimit(
                k,
                LOGIN_PROGRESSIVE_POLICY,
            );
            expect(decision.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
        });
    });

    describe('reset + isolation', () => {
        it('resetProgressiveFailures clears the counter', () => {
            const k = 'user-reset';
            for (let i = 0; i < 5; i++) {
                recordProgressiveFailure(k, LOGIN_PROGRESSIVE_POLICY);
            }
            resetProgressiveFailures(k);
            expect(
                evaluateProgressiveRateLimit(k, LOGIN_PROGRESSIVE_POLICY),
            ).toMatchObject({ allowed: true, delayMs: 0, failureCount: 0 });
        });

        it('separate keys have independent counters', () => {
            for (let i = 0; i < 10; i++) {
                recordProgressiveFailure('alice', LOGIN_PROGRESSIVE_POLICY);
            }
            expect(
                evaluateProgressiveRateLimit('alice', LOGIN_PROGRESSIVE_POLICY)
                    .allowed,
            ).toBe(false);
            expect(
                evaluateProgressiveRateLimit('bob', LOGIN_PROGRESSIVE_POLICY),
            ).toMatchObject({ allowed: true, failureCount: 0 });
        });
    });

    describe('lockout expiry', () => {
        // The primitive reads `Date.now()`. On the real clock a 10 ms lockout
        // could expire between the third failure and the first check on a
        // loaded runner, so the clock is faked and moved explicitly.
        afterEach(() => jest.useRealTimers());

        it('after the lockout window elapses, the counter resets to zero', () => {
            jest.useFakeTimers();
            const policy: ProgressiveRateLimitPolicy = {
                tiers: [{ atFailures: 2, delayMs: 1 }],
                lockoutAtFailures: 3,
                lockoutMs: 10, // 10 ms lockout
                windowMs: 60_000,
            };
            const k = 'u-expire';
            for (let i = 0; i < 3; i++) recordProgressiveFailure(k, policy);
            expect(evaluateProgressiveRateLimit(k, policy).allowed).toBe(false);

            jest.advanceTimersByTime(30);
            const decision = evaluateProgressiveRateLimit(k, policy);
            expect(decision.allowed).toBe(true);
            expect(decision.delayMs).toBe(0);
            expect(decision.failureCount).toBe(0);
        });
    });

    describe('window expiry', () => {
        // Same race as the lockout case: a 20 ms window on the real clock.
        afterEach(() => jest.useRealTimers());

        it('failures older than windowMs stop contributing', () => {
            jest.useFakeTimers();
            const policy: ProgressiveRateLimitPolicy = {
                tiers: [{ atFailures: 2, delayMs: 1 }],
                lockoutAtFailures: 5,
                lockoutMs: 60_000,
                windowMs: 20, // 20 ms rolling window
            };
            const k = 'u-window';
            for (let i = 0; i < 3; i++) recordProgressiveFailure(k, policy);
            expect(
                evaluateProgressiveRateLimit(k, policy).failureCount,
            ).toBe(3);

            jest.advanceTimersByTime(40);
            expect(
                evaluateProgressiveRateLimit(k, policy).failureCount,
            ).toBe(0);
        });
    });
});
