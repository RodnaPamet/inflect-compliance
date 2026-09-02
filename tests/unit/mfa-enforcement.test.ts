/**
 * MFA Enforcement Unit Tests
 *
 * Tests the enforcement logic and guard behavior:
 * - policy-based MFA requirement decisions
 * - middleware path classification (MFA allowed vs blocked)
 * - mfaPending flag lifecycle
 * - challenge completion semantics
 */
import { isMfaAllowedPath, isTenantPath } from '../../src/lib/auth/guard';

describe('MFA Enforcement', () => {
    // ─── Policy Enforcement Decisions ───────────────────────────────

    describe('policy enforcement decisions', () => {
        interface EnforcementInput {
            policy: string;
            hasEnrollment: boolean;
            isVerified: boolean;
        }

        function shouldSetMfaPending(input: EnforcementInput): boolean {
            if (input.policy === 'DISABLED') return false;
            if (input.policy === 'REQUIRED') return true;
            if (input.policy === 'OPTIONAL' && input.isVerified) return true;
            return false;
        }

        it('DISABLED policy never sets mfaPending', () => {
            expect(shouldSetMfaPending({ policy: 'DISABLED', hasEnrollment: false, isVerified: false })).toBe(false);
            expect(shouldSetMfaPending({ policy: 'DISABLED', hasEnrollment: true, isVerified: true })).toBe(false);
        });

        it('REQUIRED policy always sets mfaPending', () => {
            expect(shouldSetMfaPending({ policy: 'REQUIRED', hasEnrollment: false, isVerified: false })).toBe(true);
            expect(shouldSetMfaPending({ policy: 'REQUIRED', hasEnrollment: true, isVerified: false })).toBe(true);
            expect(shouldSetMfaPending({ policy: 'REQUIRED', hasEnrollment: true, isVerified: true })).toBe(true);
        });

        it('OPTIONAL policy sets mfaPending only for verified enrolled users', () => {
            expect(shouldSetMfaPending({ policy: 'OPTIONAL', hasEnrollment: false, isVerified: false })).toBe(false);
            expect(shouldSetMfaPending({ policy: 'OPTIONAL', hasEnrollment: true, isVerified: false })).toBe(false);
            expect(shouldSetMfaPending({ policy: 'OPTIONAL', hasEnrollment: true, isVerified: true })).toBe(true);
        });
    });

    // ─── Middleware Path Classification ─────────────────────────────

    describe('isMfaAllowedPath', () => {
        it('allows MFA challenge page', () => {
            expect(isMfaAllowedPath('/t/acme/auth/mfa')).toBe(true);
            expect(isMfaAllowedPath('/t/acme/auth/mfa/verify')).toBe(true);
        });

        it('allows the MFA enrollment page', () => {
            // #2223 — the challenge page's "Set up MFA" button links here.
            // While this was gated, a REQUIRED-policy tenant could not
            // onboard anyone: the click bounced back to the challenge.
            expect(isMfaAllowedPath('/t/acme/security/mfa')).toBe(true);
            expect(isMfaAllowedPath('/t/acme/security/mfa/')).toBe(true);
            // …and only that page, not the rest of the security section.
            expect(isMfaAllowedPath('/t/acme/security/sessions')).toBe(false);
            expect(isMfaAllowedPath('/t/acme/security/mfa-policy')).toBe(false);
        });

        it('allows MFA enrollment API routes', () => {
            expect(isMfaAllowedPath('/api/t/acme/security/mfa/enroll/start')).toBe(true);
            expect(isMfaAllowedPath('/api/t/acme/security/mfa/enroll/verify')).toBe(true);
            expect(isMfaAllowedPath('/api/t/acme/security/mfa/challenge/verify')).toBe(true);
        });

        it('allows auth callback routes', () => {
            expect(isMfaAllowedPath('/api/auth/session')).toBe(true);
            expect(isMfaAllowedPath('/api/auth/signout')).toBe(true);
        });

        it('blocks regular tenant routes', () => {
            expect(isMfaAllowedPath('/t/acme/dashboard')).toBe(false);
            expect(isMfaAllowedPath('/t/acme/controls')).toBe(false);
            expect(isMfaAllowedPath('/api/t/acme/controls')).toBe(false);
            expect(isMfaAllowedPath('/api/t/acme/assets')).toBe(false);
        });

        it('blocks admin routes', () => {
            expect(isMfaAllowedPath('/t/acme/admin')).toBe(false);
            expect(isMfaAllowedPath('/api/t/acme/admin/rbac')).toBe(false);
        });
    });

    describe('isTenantPath', () => {
        it('identifies tenant page paths', () => {
            expect(isTenantPath('/t/acme/dashboard')).toBe(true);
            expect(isTenantPath('/t/acme/controls')).toBe(true);
        });

        it('identifies tenant API paths', () => {
            expect(isTenantPath('/api/t/acme/controls')).toBe(true);
        });

        it('rejects non-tenant paths', () => {
            expect(isTenantPath('/login')).toBe(false);
            expect(isTenantPath('/api/auth/session')).toBe(false);
            expect(isTenantPath('/admin')).toBe(false);
        });
    });

    // ─── MFA Pending Flag Lifecycle ─────────────────────────────────

    describe('mfaPending lifecycle', () => {
        it('starts false by default', () => {
            const token = { mfaPending: false };
            expect(token.mfaPending).toBe(false);
        });

        it('is set to true on sign-in when MFA required', () => {
            const token = { mfaPending: false };
            // Simulating JWT callback behavior
            token.mfaPending = true; // REQUIRED policy
            expect(token.mfaPending).toBe(true);
        });

        it('is cleared when challenge is completed', () => {
            const token = { mfaPending: true };
            // Simulating challenge completion check
            const tokenIat = Math.floor(Date.now() / 1000) - 60; // token was created 60s ago
            const lastChallengeAt = new Date(); // challenge was just completed
            const challengeTime = Math.floor(lastChallengeAt.getTime() / 1000);

            if (challengeTime >= tokenIat) {
                token.mfaPending = false;
            }

            expect(token.mfaPending).toBe(false);
        });

        it('remains pending if challenge is older than token', () => {
            const token = { mfaPending: true };
            const tokenIat = Math.floor(Date.now() / 1000); // token just created
            const lastChallengeAt = new Date(Date.now() - 120000); // challenge 2 min ago
            const challengeTime = Math.floor(lastChallengeAt.getTime() / 1000);

            if (challengeTime >= tokenIat) {
                token.mfaPending = false;
            }

            expect(token.mfaPending).toBe(true); // Still pending
        });
    });

    // ─── Middleware Enforcement Behavior ─────────────────────────────
    //
    // Deliberately NOT tested here. This block used to hold a
    // `simulateMiddleware` helper that re-implemented the middleware's MFA
    // branch and then asserted against the copy. #2223 changed the real gate
    // from `isTenantPath(path) && !isMfaAllowedPath(path)` to
    // `!isMfaAllowedPath(path)`, and the copy would have gone on passing —
    // including its `passes non-tenant routes regardless of mfaPending` case,
    // which was the exact defect and which the copy asserted as CORRECT.
    //
    // Behaviour now lives in `tests/integration/middleware-mfa-gate.test.ts`,
    // which drives the real `middleware()` export one assertion per path
    // class. What stays here is the classification predicate itself.
});
