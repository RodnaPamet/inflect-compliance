/**
 * What the `jwt` callback does when an MFA read FAILS (#5587, #5588).
 *
 * ═══ WHY THIS FILE EXISTS AT ALL ═══
 *
 * `tests/unit/admin-cookie-mfa-failclosed.test.ts` used to cover this, with two
 * local helpers — `simulateSignInMfaCatch` and `simulateChallengeCheckCatch` —
 * whose comments said "This mirrors the catch block in auth.ts". They imported
 * nothing from `src/auth.ts`, so the four assertions certified that the test
 * file's own copy behaved as the test file had written it. The real catch blocks
 * could be fixed, broken or deleted and every test stayed green (#5589).
 *
 * Two defects lived behind that: the completion check cleared a KNOWN pending
 * challenge when its read failed, and `mfaFailClosed` was read inside the catch
 * of the very query that was supposed to assign it. A test driving the real
 * callback would have had a chance at the second; a simulation had none.
 *
 * So every test here calls `authOptions.callbacks.jwt` and asserts on the token
 * it returns. The mocks exist only to PRODUCE the failure — a double that
 * cannot produce the failing input is not a test of the thing — never to decide
 * what happens next.
 */
const tenantSecurityFindUnique = jest.fn();
const userMfaFindUnique = jest.fn(async () => ({ isVerified: true }));
// ONE membership, and it is load-bearing for the sign-in cases below:
// `applyMembershipClaims` runs before the MFA block and sets `token.tenantId`
// from it. With an empty list `activeTenantId` is null, the whole MFA block is
// skipped, and three tests here passed over code that never ran — which is how
// the first version of this file was wrong.
const userFindUnique = jest.fn(async () => ({
    id: 'user-1',
    sessionVersion: 1,
    tenantMemberships: [
        { tenantId: 'tenant-A', role: 'ADMIN', tenant: { id: 'tenant-A', slug: 'acme' } },
    ],
    orgMemberships: [],
}));

// BOTH exports, pointing at ONE object: `@/lib/prisma` exports the same client
// as `default` and as the named `prisma`, and consumers here disagree about
// which they take. A mock providing only `default` leaves the session tracker
// with an undefined client, which fails open into a DIFFERENT branch — the way
// `jwt-update-trigger-refresh.test.ts` once passed for the wrong reason.
const prismaMock = {
    tenantSecuritySettings: { findUnique: (...a: unknown[]) => tenantSecurityFindUnique(...a) },
    userMfaEnrollment: { findUnique: (...a: unknown[]) => userMfaFindUnique() },
    user: { findUnique: (...a: unknown[]) => userFindUnique() },
    tenantIdentityProvider: { findMany: async () => [] },
    userSession: { findUnique: async () => null, update: async () => ({}) },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

const workspacesPassedBySession = jest.fn();
jest.mock('@/lib/auth/workspace-mfa', () => ({
    ...(jest.requireActual('@/lib/auth/workspace-mfa') as object),
    workspacesPassedBySession: (...a: unknown[]) => workspacesPassedBySession(...a),
    workspacesAskingForCode: async () => [],
    workspacesStillAskingForCode: async (_u: string, ids: string[]) => ids,
    pendingAfterMembershipRefresh: (_t: unknown, p: { pending: boolean }) => p.pending,
}));

jest.mock('@/lib/security/session-tracker', () => ({
    recordNewSession: async () => ({ sessionId: 'sess-1' }),
    verifyAndTouchSession: async () => ({ revoked: false, touched: false, rowId: 'sess-1' }),
    workspacesPassedBySession: (...a: unknown[]) => workspacesPassedBySession(...a),
}));

import { authOptions } from '@/auth';

type JwtCb = NonNullable<NonNullable<typeof authOptions.callbacks>['jwt']>;
const jwt = authOptions.callbacks!.jwt as JwtCb;

/** A session already known to owe a challenge, on a subsequent request. */
const pendingToken = () => ({
    userId: 'user-1',
    tenantId: 'tenant-A',
    userSessionId: 'sess-1',
    mfaPending: true as boolean,
    mfaFailClosed: false as boolean | undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callJwt = (args: Record<string, unknown>) => jwt(args as any);

beforeEach(() => {
    tenantSecurityFindUnique.mockReset();
    workspacesPassedBySession.mockReset();
});

// ── the completion check (#5587) ────────────────────────────────────────

describe('a challenge this session is KNOWN to owe stays pending when the read fails', () => {
    it('does not clear mfaPending for a default tenant — the bypass', async () => {
        // mfaFailClosed false is the DEFAULT (`?? false` at both resolution
        // sites), so this was the ordinary path: one transient failure and a
        // password-only session held full access.
        workspacesPassedBySession.mockRejectedValue(new Error('pool exhausted'));

        const out = await callJwt({ token: pendingToken() });

        expect(out).toBeTruthy();
        expect((out as { mfaPending?: boolean }).mfaPending).toBe(true);
        expect((out as { error?: string }).error).toBe('MfaDependencyFailure');
    });

    it('does not clear it for a fail-closed tenant either', async () => {
        // Same answer now. The flag no longer decides this question, which is
        // the point: whether THIS session passed a challenge it already owes is
        // not a policy trade-off.
        workspacesPassedBySession.mockRejectedValue(new Error('pool exhausted'));

        const out = await callJwt({ token: { ...pendingToken(), mfaFailClosed: true } });

        expect((out as { mfaPending?: boolean }).mfaPending).toBe(true);
    });

    it('STILL clears it when the read succeeds and says this session passed', async () => {
        // The positive control. Without it, a callback that never cleared
        // mfaPending at all would satisfy both tests above and hold every
        // session at the challenge for ever.
        workspacesPassedBySession.mockResolvedValue(new Set(['tenant-A']));

        const out = await callJwt({ token: pendingToken() });

        expect((out as { mfaPending?: boolean }).mfaPending).toBe(false);
        expect((out as { error?: string }).error).toBeUndefined();
    });

    it('and leaves it pending when the read succeeds and says it did not', async () => {
        workspacesPassedBySession.mockResolvedValue(new Set(['tenant-OTHER']));

        const out = await callJwt({ token: pendingToken() });

        expect((out as { mfaPending?: boolean }).mfaPending).toBe(true);
    });
});

// ── the fail-closed flag's own read (#5588) ─────────────────────────────

describe('the fail-closed flag is resolved independently of the policy read', () => {
    /** A credentials sign-in, which skips the SSO and Entra branches. */
    const signIn = (overrides: Record<string, unknown> = {}) =>
        callJwt({
            token: { userId: 'user-1', tenantId: 'tenant-A', email: 'p@acme.test', ...overrides },
            user: { id: 'user-1', email: 'p@acme.test' },
            account: { provider: 'credentials', type: 'credentials' },
        });

    /** The full policy read throws; the one-column flag read answers. */
    function policyReadFailsFlagSays(failClosed: boolean) {
        tenantSecurityFindUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) => {
            if (args?.select && 'mfaFailClosed' in args.select) return { mfaFailClosed: failClosed };
            throw new Error('statement timeout');
        });
    }

    it('honours a FRESH sign-in\'s fail-closed choice, which it could not before', async () => {
        // THE #5588 REGRESSION. The flag used to be assigned inside the failing
        // read's own try, so on a first sign-in the catch saw `undefined`, the
        // condition was false, and the tenant's opt-in was ignored at exactly
        // the moment it was chosen for. Note the token carries NO previous
        // value — that is what makes this the fresh case.
        policyReadFailsFlagSays(true);

        const out = await signIn();

        expect((out as { mfaPending?: boolean }).mfaPending).toBe(true);
        expect((out as { error?: string }).error).toBe('MfaDependencyFailure');
    });

    it('reaches the MFA block at all — the control for the three above', async () => {
        // Without this, an empty membership list silently skips the block and
        // every assertion in this describe passes over code that never ran.
        policyReadFailsFlagSays(true);
        await signIn();
        expect(tenantSecurityFindUnique).toHaveBeenCalled();
    });

    it('keeps the sign-in fail-OPEN for a tenant that did not opt in', async () => {
        // The other half, and it must not move: refusing every sign-in when the
        // policy row cannot be read would lock a workspace out on a blip. That
        // trade-off is the one `mfaFailClosed` exists for.
        policyReadFailsFlagSays(false);

        const out = await signIn();

        expect((out as { mfaPending?: boolean }).mfaPending).toBe(false);
    });

    it('asks for the flag in a read of its own, by one column', async () => {
        // Structural, because the independence IS the fix: a flag read that
        // shared the failing query would be back where this started.
        policyReadFailsFlagSays(true);

        await signIn();

        const selects = tenantSecurityFindUnique.mock.calls
            .map((c) => (c[0] as { select?: Record<string, unknown> })?.select)
            .filter(Boolean);
        expect(selects).toContainEqual({ mfaFailClosed: true });
    });

    it('falls back to the token\'s previous value when BOTH reads fail', async () => {
        // The documented limit of an extra query: in a total outage there is
        // nothing to read the flag from. Carrying the last known value is
        // better than `undefined`, and making an unreadable row MEAN
        // fail-closed would change behaviour for tenants that never opted in.
        tenantSecurityFindUnique.mockRejectedValue(new Error('server closed the connection'));

        const out = await signIn({ mfaFailClosed: true });

        expect((out as { mfaPending?: boolean }).mfaPending).toBe(true);
    });
});
