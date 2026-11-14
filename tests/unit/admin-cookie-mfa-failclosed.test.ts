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

// ─── Fail-Closed MFA Policy ─────────────────────────────────────────

describe('Fail-closed MFA policy', () => {

    /**
     * These tests verify the fail-closed MFA logic that was implemented in
     * src/auth.ts JWT callback. They test the decision logic directly:
     * - When mfaFailClosed=true, MFA dependency failures should deny access
     * - When mfaFailClosed=false (default), a failure of the SIGN-IN policy read
     *   allows through; a failure while checking a known pending challenge
     *   never clears it (#5306). The real callback is driven in
     *   tests/unit/mfa-per-workspace.test.ts.
     */

    interface TokenState {
        mfaPending: boolean;
        mfaFailClosed: boolean;
        error?: string;
    }

    // Simulate the fail-closed catch block logic from auth.ts (sign-in path)
    function simulateSignInMfaCatch(token: TokenState): TokenState {
        // This mirrors the catch block in auth.ts JWT callback (sign-in)
        if (token.mfaFailClosed) {
            return {
                ...token,
                mfaPending: true,
                error: 'MfaDependencyFailure',
            };
        }
        // Default: fail open — no change to token
        return { ...token };
    }

    // Simulate the fail-closed catch block logic from auth.ts (challenge completion check)
    function simulateChallengeCheckCatch(token: TokenState): TokenState {
        // This mirrors the catch block in auth.ts JWT callback (challenge check)
        if (token.mfaFailClosed) {
            return {
                ...token,
                // mfaPending stays true
                error: 'MfaDependencyFailure',
            };
        }
        // Default: the challenge is known to be pending, so a failed read
        // is not a pass — mfaPending stays as it was (#5306).
        return { ...token };
    }

    describe('sign-in MFA dependency failure', () => {
        test('fail-closed: denies access when MFA lookup fails', () => {
            const result = simulateSignInMfaCatch({
                mfaPending: false,
                mfaFailClosed: true,
            });
            expect(result.mfaPending).toBe(true);
            expect(result.error).toBe('MfaDependencyFailure');
        });

        test('fail-open (default): allows access when MFA lookup fails', () => {
            const result = simulateSignInMfaCatch({
                mfaPending: false,
                mfaFailClosed: false,
            });
            expect(result.mfaPending).toBe(false);
            expect(result.error).toBeUndefined();
        });
    });

    describe('challenge completion check failure', () => {
        test('fail-closed: keeps mfaPending=true when challenge check fails', () => {
            const result = simulateChallengeCheckCatch({
                mfaPending: true, // was pending before
                mfaFailClosed: true,
            });
            expect(result.mfaPending).toBe(true);
            expect(result.error).toBe('MfaDependencyFailure');
        });

        test('fail-open: still keeps mfaPending=true when challenge check fails (#5306)', () => {
            const result = simulateChallengeCheckCatch({
                mfaPending: true, // was pending before
                mfaFailClosed: false,
            });
            expect(result.mfaPending).toBe(true);
            expect(result.error).toBeUndefined();
        });
    });

    describe('tenant opt-in/opt-out', () => {
        test('tenant with mfaFailClosed=true gets strict behavior', () => {
            const token: TokenState = { mfaPending: false, mfaFailClosed: true };
            const result = simulateSignInMfaCatch(token);
            expect(result.mfaPending).toBe(true);
            expect(result.error).toBe('MfaDependencyFailure');
        });

        test('tenant with mfaFailClosed=false gets lenient behavior (default)', () => {
            const token: TokenState = { mfaPending: false, mfaFailClosed: false };
            const result = simulateSignInMfaCatch(token);
            expect(result.mfaPending).toBe(false);
            expect(result.error).toBeUndefined();
        });
    });
});
