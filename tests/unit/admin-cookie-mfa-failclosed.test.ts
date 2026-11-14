/**
 * Unit tests for admin session guard and fail-closed MFA.
 *
 * Tests:
 *  1. shouldBlockAdminRequest — Sec-Fetch-Site validation for admin routes
 *  2. Fail-closed MFA logic integration points
 */
import { shouldBlockAdminRequest, isMutationMethod } from '@/lib/security/admin-session-guard';

// ─── Admin Session Guard: Sec-Fetch-Site Validation ──────────────────

describe('shouldBlockAdminRequest', () => {

    describe('same-origin requests', () => {
        test('allows same-origin GET', () => {
            expect(shouldBlockAdminRequest('same-origin', 'GET')).toBe(false);
        });

        test('allows same-origin POST', () => {
            expect(shouldBlockAdminRequest('same-origin', 'POST')).toBe(false);
        });

        test('allows same-origin DELETE', () => {
            expect(shouldBlockAdminRequest('same-origin', 'DELETE')).toBe(false);
        });
    });

    describe('same-site requests', () => {
        test('allows same-site GET', () => {
            expect(shouldBlockAdminRequest('same-site', 'GET')).toBe(false);
        });

        test('allows same-site POST', () => {
            expect(shouldBlockAdminRequest('same-site', 'POST')).toBe(false);
        });
    });

    describe('direct navigation (sec-fetch-site: none)', () => {
        test('allows GET (typing URL, bookmarks)', () => {
            expect(shouldBlockAdminRequest('none', 'GET')).toBe(false);
        });

        test('allows HEAD', () => {
            expect(shouldBlockAdminRequest('none', 'HEAD')).toBe(false);
        });

        test('blocks POST (mutation from direct nav is suspicious)', () => {
            expect(shouldBlockAdminRequest('none', 'POST')).toBe(true);
        });

        test('blocks PUT', () => {
            expect(shouldBlockAdminRequest('none', 'PUT')).toBe(true);
        });

        test('blocks DELETE', () => {
            expect(shouldBlockAdminRequest('none', 'DELETE')).toBe(true);
        });
    });

    describe('cross-site requests', () => {
        test('blocks cross-site GET', () => {
            expect(shouldBlockAdminRequest('cross-site', 'GET')).toBe(true);
        });

        test('blocks cross-site POST', () => {
            expect(shouldBlockAdminRequest('cross-site', 'POST')).toBe(true);
        });

        test('blocks cross-site PUT', () => {
            expect(shouldBlockAdminRequest('cross-site', 'PUT')).toBe(true);
        });

        test('blocks cross-site DELETE', () => {
            expect(shouldBlockAdminRequest('cross-site', 'DELETE')).toBe(true);
        });

        test('blocks cross-site PATCH', () => {
            expect(shouldBlockAdminRequest('cross-site', 'PATCH')).toBe(true);
        });
    });

    describe('missing header (old browsers, curl)', () => {
        test('allows null header — auth token is still required', () => {
            expect(shouldBlockAdminRequest(null, 'GET')).toBe(false);
        });

        test('allows undefined header', () => {
            expect(shouldBlockAdminRequest(undefined, 'POST')).toBe(false);
        });

        test('allows empty string header', () => {
            expect(shouldBlockAdminRequest('', 'DELETE')).toBe(false);
        });
    });

    describe('unknown header values', () => {
        test('blocks unknown value for safety', () => {
            expect(shouldBlockAdminRequest('unknown-value', 'GET')).toBe(true);
        });
    });
});

// ─── Mutation Method Detection ───────────────────────────────────────

describe('isMutationMethod', () => {
    test('POST is a mutation', () => {
        expect(isMutationMethod('POST')).toBe(true);
    });

    test('PUT is a mutation', () => {
        expect(isMutationMethod('PUT')).toBe(true);
    });

    test('PATCH is a mutation', () => {
        expect(isMutationMethod('PATCH')).toBe(true);
    });

    test('DELETE is a mutation', () => {
        expect(isMutationMethod('DELETE')).toBe(true);
    });

    test('GET is not a mutation', () => {
        expect(isMutationMethod('GET')).toBe(false);
    });

    test('HEAD is not a mutation', () => {
        expect(isMutationMethod('HEAD')).toBe(false);
    });

    test('OPTIONS is not a mutation', () => {
        expect(isMutationMethod('OPTIONS')).toBe(false);
    });

    test('case-insensitive', () => {
        expect(isMutationMethod('post')).toBe(true);
        expect(isMutationMethod('get')).toBe(false);
    });
});

// ─── Fail-closed MFA: moved, and why ────────────────────────────────
//
// A `describe('Fail-closed MFA policy')` block lived here with two local
// helpers, `simulateSignInMfaCatch` and `simulateChallengeCheckCatch`, whose
// comments read "This mirrors the catch block in auth.ts". They imported
// nothing from `src/auth.ts`, so the four assertions certified that this
// file's own copy behaved as this file had written it. The real catch blocks
// could be fixed, broken or deleted and every test stayed green (#5589).
//
// Two defects behind it went unnoticed with those tests passing: the
// completion check cleared a KNOWN pending challenge when its read failed
// (#5587), and `mfaFailClosed` was read inside the catch of the very query
// that was supposed to assign it (#5588).
//
// They are now in `tests/unit/auth-mfa-dependency-failure.test.ts`, which
// calls the real `authOptions.callbacks.jwt` and asserts on the token it
// returns. Nothing was lost: every case the simulators covered has a
// counterpart there, driven through the callback.
//
// The file name is kept because the admin-session-guard tests above are its
// subject and are unaffected.
