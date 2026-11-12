/**
 * Unit tests for src/app-layer/usecases/mfa-challenge.ts
 *
 * The MFA challenge usecase is the second-factor verifier on every login that
 * hits the MFA gate. A bug here is a silent MFA bypass.
 *
 * Behaviours protected:
 *   1. Missing enrollment / unverified enrollment ⇒ badRequest
 *   2. Wrong TOTP code ⇒ failure result + MFA_CHALLENGE_FAILED audit
 *   3. Right TOTP code ⇒ the step is claimed on the enrolment, the pass is
 *      recorded on THIS session's row, MFA_CHALLENGE_PASSED audit
 *   4. A code is accepted once: a step not later than the last accepted one
 *      fails, and the claim is a conditional update
 *   5. A request that names no live session of this user's cannot pass:
 *      nothing would bind the pass to it
 *   6. Audit emission errors are swallowed (best-effort)
 */

jest.mock('@/lib/prisma', () => ({
    prisma: {
        userMfaEnrollment: {
            findUnique: jest.fn(),
            updateMany: jest.fn(),
        },
        userSession: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock('@/lib/security/totp-crypto', () => ({
    decryptTotpSecret: jest.fn(),
    matchTotpStep: jest.fn(),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/env', () => ({
    env: { AUTH_SECRET: 'test-auth-secret-32-chars-or-more-xx' }, // pragma: allowlist secret — placeholder so totp encryption module loads under test
}));

import { verifyMfaChallenge } from '@/app-layer/usecases/mfa-challenge';
import { prisma } from '@/lib/prisma';
import { decryptTotpSecret, matchTotpStep } from '@/lib/security/totp-crypto';
import { logEvent } from '@/app-layer/events/audit';

const mockFindUnique = prisma.userMfaEnrollment.findUnique as jest.Mock;
const mockClaim = prisma.userMfaEnrollment.updateMany as jest.Mock;
const mockSessionFind = prisma.userSession.findUnique as jest.Mock;
const mockSessionUpdate = prisma.userSession.update as jest.Mock;
const mockDecrypt = decryptTotpSecret as jest.MockedFunction<typeof decryptTotpSecret>;
const mockStep = matchTotpStep as jest.MockedFunction<typeof matchTotpStep>;
const mockLogEvent = logEvent as jest.MockedFunction<typeof logEvent>;

const enrollmentRow = {
    id: 'enrollment-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    type: 'TOTP' as const,
    secretEncrypted: 'enc-blob',
    isVerified: true,
    lastAcceptedTotpStep: 100,
};
const liveSession = {
    userId: 'user-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
};

beforeEach(() => {
    jest.clearAllMocks();
    mockDecrypt.mockReturnValue('JBSWY3DPEHPK3PXP');
    mockFindUnique.mockResolvedValue(enrollmentRow);
    mockSessionFind.mockResolvedValue(liveSession);
    mockSessionUpdate.mockResolvedValue({});
    mockClaim.mockResolvedValue({ count: 1 });
    mockLogEvent.mockResolvedValue(undefined as never);
});

const verify = (code = '654321', sessionId: string | null = 'sess-1') =>
    verifyMfaChallenge('user-1', 'tenant-1', code, 5, sessionId);

describe('verifyMfaChallenge', () => {
    it('throws badRequest when no enrollment exists', async () => {
        mockFindUnique.mockResolvedValue(null);
        await expect(verify()).rejects.toThrow(/MFA not configured/);
        expect(mockStep).not.toHaveBeenCalled();
    });

    it('throws badRequest when the enrollment is not verified', async () => {
        mockFindUnique.mockResolvedValue({ ...enrollmentRow, isVerified: false });
        await expect(verify()).rejects.toThrow(/MFA not configured/);
        expect(mockStep).not.toHaveBeenCalled();
    });

    it('fails a wrong code, claims nothing, binds nothing, and records the failure', async () => {
        mockStep.mockReturnValue(null);
        const result = await verifyMfaChallenge('user-1', 'tenant-1', '123456', 2, 'sess-1');
        expect(result).toMatchObject({ success: false, remaining: 2 });
        expect(mockClaim).not.toHaveBeenCalled();
        expect(mockSessionUpdate).not.toHaveBeenCalled();
        expect(mockLogEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ tenantId: 'tenant-1', userId: 'user-1' }),
            expect.objectContaining({ action: 'MFA_CHALLENGE_FAILED' }),
        );
    });

    it('passes a right code: claims a LATER step only, then binds the pass to this session', async () => {
        mockStep.mockReturnValue(101);
        const result = await verify();
        expect(result.success).toBe(true);
        expect(mockClaim).toHaveBeenCalledWith({
            where: {
                id: 'enrollment-1',
                OR: [{ lastAcceptedTotpStep: null }, { lastAcceptedTotpStep: { lt: 101 } }],
            },
            data: { lastAcceptedTotpStep: 101, lastChallengeAt: expect.any(Date) },
        });
        expect(mockSessionUpdate).toHaveBeenCalledWith({
            where: { sessionId: 'sess-1' },
            data: { mfaPassedTenantIds: { push: 'tenant-1' } },
        });
        expect(mockLogEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'MFA_CHALLENGE_PASSED' }),
        );
    });

    it('refuses a code whose step was already used: the claim updates nothing', async () => {
        mockStep.mockReturnValue(100);
        mockClaim.mockResolvedValue({ count: 0 });
        const result = await verify();
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/already-used/);
        expect(mockSessionUpdate).not.toHaveBeenCalled();
    });

    it.each([
        ['no session id', null, liveSession],
        ['an unknown session', 'sess-1', null],
        ['another person’s session', 'sess-1', { ...liveSession, userId: 'someone-else' }],
        ['a revoked session', 'sess-1', { ...liveSession, revokedAt: new Date() }],
        ['an expired session', 'sess-1', { ...liveSession, expiresAt: new Date(Date.now() - 1000) }],
    ])('refuses with %s, before checking the code', async (_l, sessionId, row) => {
        mockSessionFind.mockResolvedValue(row);
        const result = await verify('654321', sessionId);
        expect(result.success).toBe(false);
        expect(mockStep).not.toHaveBeenCalled();
        expect(mockClaim).not.toHaveBeenCalled();
        expect(mockSessionUpdate).not.toHaveBeenCalled();
    });

    it('still returns success when the audit emit throws', async () => {
        mockStep.mockReturnValue(101);
        mockLogEvent.mockRejectedValue(new Error('audit chain unreachable'));
        await expect(verify()).resolves.toMatchObject({ success: true });
        expect(mockSessionUpdate).toHaveBeenCalled();
    });

    it('looks up the enrollment scoped to (userId, tenantId, TOTP)', async () => {
        mockStep.mockReturnValue(101);
        await verify();
        expect(mockFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId_tenantId_type: { userId: 'user-1', tenantId: 'tenant-1', type: 'TOTP' } },
            }),
        );
    });
});
