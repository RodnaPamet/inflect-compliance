/**
 * Unit Test: Epic A.3 brute-force protection integrated into
 * authenticateWithPassword.
 *
 * Proves that the credentials chokepoint:
 *   - records a progressive failure on each bad verify
 *   - requests the correct delay from LOGIN_PROGRESSIVE_POLICY, and
 *     requests it BEFORE the bcrypt verify
 *   - locks out at 10 failures and returns `rate_limited` +
 *     retryAfterSeconds (without bcrypt-verify'ing anything), while
 *     still paying the dummyVerify timing-equalisation cost
 *   - resets the counter on a successful verify so the next login
 *     starts clean
 *   - routes are identifier-isolated: one user's failures don't
 *     slow down another
 *
 * All external side effects (DB, audit log, Upstash) are mocked so
 * the test exercises the in-memory progressive store + the delay
 * branch without any network/DB churn.
 *
 * ## Why there is no stopwatch in here (#2350)
 * THREE assertions were deleted, all of them wall-clock reads, and they
 * are not all the same kind of loss:
 *
 *   - `expect(elapsed).toBeLessThan(7_000)` around a REAL five-second
 *     sleep. A 1.4x margin whose only unique contribution was to fail
 *     if the delay ran LONG, which is exactly what a busy runner makes
 *     a correct implementation do. This is the flake, and it is pure
 *     loss to nobody.
 *   - `expect(elapsed).toBeGreaterThanOrEqual(4_900)`, the floor on the
 *     same sleep. This one was load-bearing: it proved the delay was
 *     actually SERVED, not merely requested, which is the property an
 *     attacker's stopwatch feels. Deleting it silently would have been
 *     the whole cost of this change.
 *   - `expect(elapsed).toBeLessThan(1500)` over attempts 1-2 to mean
 *     "no delay has fired yet", which cannot distinguish "nothing was
 *     requested" from "something small was".
 *
 * The two CEILINGS are replaced by asserting the delay the code
 * REQUESTED, through the `sleepImpl` seam on
 * `authenticateWithPassword`. The requested number is a pure function
 * of LOGIN_PROGRESSIVE_POLICY — the same integer on every machine,
 * under any load — and it is compared against the policy constant
 * rather than a literal, so retuning the policy retunes the test. Same
 * remedy as tests/unit/framework-tree-builder.test.ts ("does not read
 * the input quadratically") and tests/unit/password-check.test.ts:183-197.
 *
 * The FLOOR is replaced by "serves that delay on a REAL timer when
 * nothing is injected" below, which takes the seam's production default
 * — no `sleepImpl` argument at all — under fake timers and asserts the
 * call stays parked on a pending timer until exactly `tier1.delayMs`
 * has been advanced. Served, stated exactly instead of as `>= 4_900`,
 * at no wall-clock cost. Its residual against the deleted form, stated
 * rather than glossed: it drives jest's fake `setTimeout`, so it proves
 * the delay is scheduled for the right duration and awaited, not that
 * the host timer fires. Nothing here sleeps or reads a wall clock; the
 * one real timer left is the zero-millisecond yield inside that test,
 * which turns the event loop and is never measured.
 *
 * Three mutations that left the previous six tests fully green are
 * caught here. Each was run, not assumed:
 *
 *   - the progressive delay applied AFTER the bcrypt verify instead of
 *     before it, so an attacker's stopwatch never feels it in front of
 *     the expensive operation;
 *   - the lockout branch no longer calling `dummyVerify`, turning a
 *     locked identifier into a measurably faster answer than every
 *     other failure branch — an account-enumeration oracle;
 *   - a delay requested on every attempt, including the two free ones
 *     the typo allowance exists to give.
 *
 * A fourth runs the other way, and it is why the floor had to be
 * REPLACED rather than simply dropped. Deleting the delay in production
 * — `await sleep(...)` removed at HEAD~1, or equivalently the seam's
 * default mutated to `options.sleepImpl ?? (async () => undefined)`
 * here — is precisely what the floor caught, and what nothing else did:
 * with the floor gone and before the default-path test existed, that
 * mutation was green across all five auth suites, 55 tests.
 *
 * The default-path test below is the only thing that reddens it, and
 * the population that was actually run for that is worth naming, since
 * "sole detector" is otherwise a claim about a suite nobody measured.
 * The mutation cannot escape the seam: `authenticateWithPassword` is
 * exported from one module, re-exported from none, and imported by
 * exactly one production file (`src/auth.ts`). So the suites that can
 * reach it are the ones naming `authenticateWithPassword`,
 * `@/lib/auth/credentials` or `@/auth` — ten files — plus
 * progressive-rate-limit, which owns the policy. All eleven were run
 * mutated, 104 tests: one failure, the test below, at its
 * `jest.getTimerCount()` assertion. The other way a suite could notice
 * is by reading credentials.ts as TEXT, and the four that do are all
 * already in those eleven. So outside that reach the mutation is
 * unobservable rather than untested.
 *
 * And it stops sleeping: this file ran 6.20/6.09/6.21s at HEAD~1 and
 * 1.07/1.00/1.14s as it stands, three interleaved rounds on one 8-core
 * box at load average 2.3-2.6 on 2026-09-07. Nothing here asserts that.
 */

// ── Env setup: enable rate limits, disable test-mode shortcut ───────
const originalTestMode = process.env.AUTH_TEST_MODE;
const originalRateLimitEnabled = process.env.RATE_LIMIT_ENABLED;

beforeAll(() => {
    process.env.AUTH_TEST_MODE = '0';
    process.env.RATE_LIMIT_ENABLED = '1';
});

afterAll(() => {
    if (originalTestMode === undefined) delete process.env.AUTH_TEST_MODE;
    else process.env.AUTH_TEST_MODE = originalTestMode;
    if (originalRateLimitEnabled === undefined) {
        delete process.env.RATE_LIMIT_ENABLED;
    } else {
        process.env.RATE_LIMIT_ENABLED = originalRateLimitEnabled;
    }
});

// ── Module mocks ─────────────────────────────────────────────────────

// Upstash per-identifier check — make it a no-op pass so ONLY the
// progressive layer decides.
jest.mock('@/lib/auth/credential-rate-limit', () => ({
    checkCredentialsAttempt: jest.fn(async () => ({ ok: true })),
    resetCredentialsBackoff: jest.fn(async () => undefined),
}));

// Audit emission — avoid DB writes.
jest.mock('@/lib/auth/security-events', () => ({
    recordLoginFailure: jest.fn(async () => undefined),
    recordLoginSuccess: jest.fn(async () => undefined),
}));

// Password primitives — deterministic, no bcrypt cost.
jest.mock('@/lib/auth/passwords', () => ({
    verifyPassword: jest.fn(),
    dummyVerify: jest.fn(async () => undefined),
    needsRehash: jest.fn(() => false),
    hashPassword: jest.fn(async () => 'hashed'),
    BCRYPT_COST: 12,
}));

// Prisma — simulate "user exists with a password hash".
const fakeUser = {
    id: 'user-1',
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: '$2a$12$abcdefghijklmnopqrstuvwxyzABCDE1234567890abc',
    emailVerified: new Date(),
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: {
            findUnique: jest.fn(async () => fakeUser),
            update: jest.fn(async () => fakeUser),
        },
    },
    prisma: {
        user: {
            findUnique: jest.fn(async () => fakeUser),
            update: jest.fn(async () => fakeUser),
        },
    },
}));

// env shim — avoids loading the real zod env schema (which requires
// many vars and aborts in minimal test scenarios).
jest.mock('@/env', () => ({
    env: {
        AUTH_TEST_MODE: '0',
        RATE_LIMIT_ENABLED: '1',
        AUTH_REQUIRE_EMAIL_VERIFICATION: '0',
    },
}));

import { authenticateWithPassword } from '@/lib/auth/credentials';
import { dummyVerify, verifyPassword } from '@/lib/auth/passwords';
import {
    clearAllRateLimits,
    LOGIN_PROGRESSIVE_POLICY,
} from '@/lib/security/rate-limit';

// ── Tests ────────────────────────────────────────────────────────────

describe('authenticateWithPassword — Epic A.3 progressive brute-force', () => {
    const email = 'alice@example.com';
    const password = 'correct-horse-battery-staple'; // pragma: allowlist secret — test-only password literal

    beforeEach(() => {
        clearAllRateLimits();
        jest.clearAllMocks();
    });

    // `clearAllMocks` clears CALLS but keeps implementations, so a
    // `mockImplementation` set by one test would silently serve the
    // next one. Reset the only mock any test here reprograms.
    afterEach(() => {
        (verifyPassword as jest.Mock).mockReset();
    });

    /**
     * Records every progressive delay the chokepoint asks for, and
     * serves each one instantly. The array IS the assertion subject:
     * it holds the numbers the implementation chose, not the numbers
     * the machine happened to deliver.
     */
    function recordingSleep(): {
        requested: number[];
        sleepImpl: (ms: number) => Promise<void>;
    } {
        const requested: number[] = [];
        return {
            requested,
            sleepImpl: async (ms: number) => {
                requested.push(ms);
            },
        };
    }

    it('requests no delay on the first two bad attempts (typo allowance)', async () => {
        (verifyPassword as jest.Mock).mockResolvedValue(false);
        const { requested, sleepImpl } = recordingSleep();

        const first = await authenticateWithPassword(
            { email, password },
            { sleepImpl },
        );
        const second = await authenticateWithPassword(
            { email, password },
            { sleepImpl },
        );

        // POSITIVE companion for the negative assertion below. Without
        // these, a chokepoint that never reached the progressive block at
        // all — or never called sleepImpl anywhere — would pass just as
        // happily as the correct one.
        expect(first.ok).toBe(false);
        expect(second.ok).toBe(false);
        expect(verifyPassword).toHaveBeenCalledTimes(2);

        const { evaluateProgressiveRateLimit } = await import(
            '@/lib/security/rate-limit'
        );
        const { progressiveKey } = await getKeyFor(email);
        const decision = evaluateProgressiveRateLimit(
            progressiveKey,
            LOGIN_PROGRESSIVE_POLICY,
        );
        // The progressive layer ran and counted both failures …
        expect(decision.failureCount).toBe(2);
        // … and at that count the policy itself asks for nothing, which
        // is the thing being asserted — tied to the policy, not to a
        // hand-copied 1500ms ceiling that stops meaning anything the
        // moment the tiers are retuned.
        expect(decision.delayMs).toBe(0);
        expect(requested).toEqual([]);
    });

    it('requests the tier-1 delay on the fourth attempt, before the verify', async () => {
        // Policy reads as "after N failures, next attempt delays M".
        // So 3 failures → 4th attempt delays. evaluateProgressiveRateLimit
        // is called pre-verify with the CURRENT count; the 4th invocation
        // sees count=3 and picks tier 1.
        const { requested, sleepImpl } = recordingSleep();

        // One ordered log across both seams, so "the delay is applied
        // BEFORE the expensive verify" — the property the production
        // comment claims and the reason an attacker's stopwatch feels
        // it — is asserted rather than assumed.
        const order: string[] = [];
        (verifyPassword as jest.Mock).mockImplementation(async () => {
            order.push('verify');
            return false;
        });
        const orderedSleep = async (ms: number) => {
            order.push(`sleep:${ms}`);
            await sleepImpl(ms);
        };

        for (let i = 0; i < 3; i++) {
            await authenticateWithPassword(
                { email, password },
                { sleepImpl: orderedSleep },
            );
        }
        // Attempts 1-3 saw counts 0/1/2 — all below tier 1.
        expect(requested).toEqual([]);

        const result = await authenticateWithPassword(
            { email, password },
            { sleepImpl: orderedSleep },
        );

        expect(result.ok).toBe(false);
        // Compared against the policy, not a literal 5000: the tier
        // VALUES are pinned by tests/unit/progressive-rate-limit.test.ts,
        // which owns the policy. What is unpinned until here is whether
        // the chokepoint SERVES the number the policy chose — so that is
        // what this asserts, and retuning the policy retunes it.
        // `tier1.atFailures` needs no assertion of its own: raise it and
        // the loop above stops reaching the tier, which the empty
        // `requested` check three lines up already catches.
        const tier1 = LOGIN_PROGRESSIVE_POLICY.tiers[0];
        expect(requested).toEqual([tier1.delayMs]);
        expect(order).toEqual([
            'verify',
            'verify',
            'verify',
            `sleep:${tier1.delayMs}`,
            'verify',
        ]);
    });

    it('serves that delay on a REAL timer when nothing is injected (the production default)', async () => {
        // The seam has a default, and the default is the arm the one
        // production call site takes (src/auth.ts:358, which passes no
        // second argument). Every other test in this file either injects
        // a `sleepImpl` or never reaches a delay at all, so every one of
        // them stays green if
        // `options.sleepImpl ?? sleep` is mutated to
        // `options.sleepImpl ?? (async () => undefined)` — the Epic A.3
        // progressive delay silently deleted in production while the
        // tests go on asserting the number it would have asked for.
        // This test reads the default arm, and is the only thing that
        // does. That mutation was run across every suite that can reach
        // the seam — see the file header for how the eleven were
        // derived — and this is the one it reddens.
        //
        // It is also where "the delay is SERVED, not merely REQUESTED"
        // lives now — the guarantee the deleted
        // `expect(elapsed).toBeGreaterThanOrEqual(4_900)` carried on the
        // wall clock. Fake time gives it exactly rather than
        // approximately, and without sleeping.
        (verifyPassword as jest.Mock).mockResolvedValue(false);
        const tier1 = LOGIN_PROGRESSIVE_POLICY.tiers[0];

        // Reach the tier without spending four calls getting there —
        // the count-to-tier walk is the previous test's subject; this
        // one is about the arm that serves the delay.
        const { recordProgressiveFailure } = await import(
            '@/lib/security/rate-limit'
        );
        const { progressiveKey } = await getKeyFor(email);
        for (let i = 0; i < tier1.atFailures; i++) {
            recordProgressiveFailure(progressiveKey, LOGIN_PROGRESSIVE_POLICY);
        }

        // Captured BEFORE the fake clock is installed: the chokepoint
        // awaits a WebCrypto digest on its way to the delay, and that
        // resolves off the libuv threadpool, so no amount of FAKE time
        // moves it. Only a real event-loop turn does.
        const realSetTimeout = globalThis.setTimeout;
        const realYield = () =>
            new Promise<void>((resolve) => {
                realSetTimeout(resolve, 0);
            });

        jest.useFakeTimers();
        try {
            const timersBefore = jest.getTimerCount();
            let settled = false;
            // No second argument at all — byte-for-byte the shape
            // `src/auth.ts` calls.
            const pending = authenticateWithPassword({ email, password }).then(
                (r) => {
                    settled = true;
                    return r;
                },
            );

            // Give the digest and the rate-limit gate real turns to
            // finish, stopping as soon as the delay's timer is pending.
            // The budget is only reached when no timer is ever
            // scheduled, which is exactly what a no-op default does.
            for (
                let i = 0;
                i < 50 && jest.getTimerCount() === timersBefore;
                i++
            ) {
                await realYield();
            }

            // Parked on a timer, and not finished: the pre-delay work is
            // done, so `settled` being false is the delay holding it and
            // not the digest still in flight.
            expect(jest.getTimerCount()).toBe(timersBefore + 1);
            expect(settled).toBe(false);

            // One millisecond short of the tier, still blocked …
            await jest.advanceTimersByTimeAsync(tier1.delayMs - 1);
            expect(settled).toBe(false);

            // … and the last millisecond releases it. So the timer is
            // neither absent nor shorter than the policy asked for.
            await jest.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);

            const result = await pending;
            expect(result.ok).toBe(false);
            // The verify it was gating ran afterwards, so what the block
            // above measured is the delay and not an unrelated stall.
            expect(verifyPassword).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it('locks out at 10 failures and returns rate_limited without verifying', async () => {
        (verifyPassword as jest.Mock).mockResolvedValue(false);

        // Use a bypass path for the first 9 failures: pre-populate the
        // counter by calling the function 9 times. To keep test latency
        // sane, we use a tighter policy via a fresh key — but since the
        // integration test pins the real policy, we skip the delayed
        // tiers by short-circuiting through recordProgressiveFailure.
        const { recordProgressiveFailure } = await import(
            '@/lib/security/rate-limit'
        );

        // Emulate 10 failures for this identifier.
        const { progressiveKey } = await getKeyFor(email);
        for (let i = 0; i < 10; i++) {
            recordProgressiveFailure(progressiveKey, LOGIN_PROGRESSIVE_POLICY);
        }

        const { requested, sleepImpl } = recordingSleep();
        const result = await authenticateWithPassword(
            { email, password },
            { sleepImpl },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('rate_limited');
            expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        }
        // No real verify attempt should have happened — lockout
        // short-circuits before verifyPassword.
        expect(verifyPassword).not.toHaveBeenCalled();

        // …but the bcrypt-cost burn MUST still be paid. `dummyVerify` is
        // what makes a locked-out account indistinguishable, on the
        // attacker's stopwatch, from an account whose password was simply
        // wrong (module header, "Error shape (account-enumeration safe)").
        // Skipping it turns the lockout into an account-enumeration
        // oracle: the locked identifier would answer measurably faster
        // than every other failure branch, all of which call dummyVerify.
        expect(dummyVerify).toHaveBeenCalledTimes(1);
        expect(dummyVerify).toHaveBeenCalledWith(password);

        // And the injectable delay seam does NOT reach it — passing a
        // no-op sleepImpl shortens the progressive delay and leaves the
        // equalisation exactly where it was. If the seam ever swallowed
        // dummyVerify, this pair would go (0 calls, 1 request).
        expect(requested).toEqual([]);
    });

    it('successful login resets the progressive counter', async () => {
        const { recordProgressiveFailure, evaluateProgressiveRateLimit } =
            await import('@/lib/security/rate-limit');
        const { progressiveKey } = await getKeyFor(email);

        // Pre-load 2 failures so the identifier is "warm" but not delayed.
        for (let i = 0; i < 2; i++) {
            recordProgressiveFailure(progressiveKey, LOGIN_PROGRESSIVE_POLICY);
        }
        expect(
            evaluateProgressiveRateLimit(
                progressiveKey,
                LOGIN_PROGRESSIVE_POLICY,
            ).failureCount,
        ).toBe(2);

        // Successful verify.
        (verifyPassword as jest.Mock).mockResolvedValue(true);
        const result = await authenticateWithPassword({ email, password });
        expect(result.ok).toBe(true);

        // Counter cleared.
        expect(
            evaluateProgressiveRateLimit(
                progressiveKey,
                LOGIN_PROGRESSIVE_POLICY,
            ).failureCount,
        ).toBe(0);
    });

    it('two different identifiers have independent progressive counters', async () => {
        (verifyPassword as jest.Mock).mockResolvedValue(false);

        const { recordProgressiveFailure, evaluateProgressiveRateLimit } =
            await import('@/lib/security/rate-limit');

        const aliceKey = (await getKeyFor('alice@example.com')).progressiveKey;
        const bobKey = (await getKeyFor('bob@example.com')).progressiveKey;

        for (let i = 0; i < 10; i++) {
            recordProgressiveFailure(aliceKey, LOGIN_PROGRESSIVE_POLICY);
        }
        expect(
            evaluateProgressiveRateLimit(aliceKey, LOGIN_PROGRESSIVE_POLICY)
                .allowed,
        ).toBe(false);
        expect(
            evaluateProgressiveRateLimit(bobKey, LOGIN_PROGRESSIVE_POLICY)
                .allowed,
        ).toBe(true);
    });

    it('never includes password material in the AuthResult', async () => {
        (verifyPassword as jest.Mock).mockResolvedValue(false);
        const result = await authenticateWithPassword({ email, password });
        expect(JSON.stringify(result)).not.toContain(password);
    });
});

/**
 * Helper to derive the progressive key the way credentials.ts does.
 * Duplicated here to keep the integration assertions black-box and
 * to avoid exporting an internal from credentials.ts solely for
 * testing.
 */
async function getKeyFor(email: string): Promise<{ progressiveKey: string }> {
    const encoder = new TextEncoder();
    const buf = await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(email.trim().toLowerCase()),
    );
    const hex = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return { progressiveKey: `login-progressive:${hex}` };
}
