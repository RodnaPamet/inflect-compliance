/**
 * Unit tests for src/lib/auth/security-events.ts — the auth-path audit
 * + structured-log emitter.
 *
 * Covers the contract the chokepoint + verification endpoints rely on:
 *   - Login success writes an AUTH_LOGIN_SUCCESS audit row tied to the
 *     user's resolved tenant
 *   - Failure with unknown user / no tenant does NOT write audit (would
 *     need a sentinel tenant, which we explicitly don't have)
 *   - Failure for a known user *with* a membership DOES write audit,
 *     with the right action derived from the reason
 *   - Every audited payload uses hashed email only — plaintext email,
 *     passwords, and any metadata from the caller never hit appendAudit
 *   - audit-write errors don't propagate (they fall back to warn log)
 */

// ── Mocks ──────────────────────────────────────────────────────────────

const mockFindFirst = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantMembership: {
            findFirst: (...a: unknown[]) => mockFindFirst(...a),
        },
    },
}));

const mockAppendAuditEntry: jest.Mock<Promise<unknown>, unknown[]> = jest.fn(
    async () => ({ id: 'a', entryHash: 'h', previousHash: null }),
);
jest.mock('@/lib/audit', () => ({
    __esModule: true,
    appendAuditEntry: (...a: unknown[]) => mockAppendAuditEntry(...a),
}));

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { info: mockLoggerInfo, warn: mockLoggerWarn, error: jest.fn(), debug: jest.fn() },
}));

import {
    AUTH_ACTIONS,
    recordLoginFailure,
    recordLoginSuccess,
    hashEmailForLog,
} from '@/lib/auth/security-events';
import { createHash } from 'node:crypto';
import { hashForLookup } from '@/lib/security/encryption';

beforeEach(() => {
    mockFindFirst.mockReset();
    mockAppendAuditEntry.mockReset();
    mockAppendAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
});

// ── Success path ───────────────────────────────────────────────────────

describe('recordLoginSuccess', () => {
    it('writes an AUTH_LOGIN_SUCCESS audit row scoped to the resolved tenant', async () => {
        mockFindFirst.mockResolvedValue({ tenantId: 'tnt_1' });

        await recordLoginSuccess({
            email: 'alice@example.com',
            userId: 'usr_1',
            method: 'credentials',
            requestId: 'req_1',
        });

        expect(mockAppendAuditEntry).toHaveBeenCalledTimes(1);
        const payload = mockAppendAuditEntry.mock.calls[0][0] as {
            tenantId: string;
            userId: string;
            action: string;
            entity: string;
            detailsJson: { auth: { method: string; identifierHash: string } };
        };
        expect(payload.tenantId).toBe('tnt_1');
        expect(payload.userId).toBe('usr_1');
        expect(payload.action).toBe(AUTH_ACTIONS.LOGIN_SUCCESS);
        expect(payload.entity).toBe('Auth');
        expect(payload.detailsJson.auth.method).toBe('credentials');
        expect(payload.detailsJson.auth.identifierHash).toBe(
            hashEmailForLog('alice@example.com'),
        );
    });

    it('does NOT write audit when the user has no membership', async () => {
        mockFindFirst.mockResolvedValue(null);

        await recordLoginSuccess({
            email: 'alice@example.com',
            userId: 'usr_1',
            method: 'credentials',
        });

        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
        // Still leaves an operational log line so SREs see the login
        expect(mockLoggerInfo).toHaveBeenCalled();
    });

    it('emits a structured logger.info event regardless of audit outcome', async () => {
        mockFindFirst.mockResolvedValue({ tenantId: 'tnt_1' });
        await recordLoginSuccess({
            email: 'alice@example.com',
            userId: 'usr_1',
            method: 'google',
        });
        expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
        const [, fields] = mockLoggerInfo.mock.calls[0] as [
            string,
            Record<string, unknown>,
        ];
        expect(fields.event).toBe('login_success');
        expect(fields.method).toBe('google');
        expect(fields.identifierHash).toBeTruthy();
        // Plaintext email must not leak into the structured log either
        expect(JSON.stringify(fields)).not.toContain('alice@example.com');
    });
});

// ── Failure path ───────────────────────────────────────────────────────

describe('recordLoginFailure', () => {
    it('writes AUTH_LOGIN_FAILURE when reason is credentials_invalid and user+tenant resolve', async () => {
        mockFindFirst.mockResolvedValue({ tenantId: 'tnt_1' });

        await recordLoginFailure({
            email: 'alice@example.com',
            userId: 'usr_1',
            method: 'credentials',
            reason: 'credentials_invalid',
        });

        expect(mockAppendAuditEntry).toHaveBeenCalledTimes(1);
        const payload = mockAppendAuditEntry.mock.calls[0][0] as {
            action: string;
            detailsJson: { auth: { reason?: string } };
        };
        expect(payload.action).toBe(AUTH_ACTIONS.LOGIN_FAILURE);
        expect(payload.detailsJson.auth.reason).toBe('credentials_invalid');
    });

    it('maps reason=rate_limited to the dedicated AUTH_LOGIN_RATE_LIMITED action', async () => {
        mockFindFirst.mockResolvedValue({ tenantId: 'tnt_1' });

        await recordLoginFailure({
            email: 'alice@example.com',
            userId: 'usr_1',
            method: 'credentials',
            reason: 'rate_limited',
        });

        expect(mockAppendAuditEntry.mock.calls[0][0]).toEqual(
            expect.objectContaining({ action: AUTH_ACTIONS.LOGIN_RATE_LIMITED }),
        );
    });

    it('maps reason=email_not_verified to AUTH_LOGIN_EMAIL_VERIFICATION_REQUIRED', async () => {
        mockFindFirst.mockResolvedValue({ tenantId: 'tnt_1' });

        await recordLoginFailure({
            email: 'alice@example.com',
            userId: 'usr_1',
            method: 'credentials',
            reason: 'email_not_verified',
        });

        expect(mockAppendAuditEntry.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                action: AUTH_ACTIONS.LOGIN_EMAIL_VERIFICATION_REQUIRED,
            }),
        );
    });

    it('does NOT write audit when user is unknown (reason=unknown_email)', async () => {
        await recordLoginFailure({
            email: 'ghost@example.com',
            userId: null,
            method: 'credentials',
            reason: 'unknown_email',
        });
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
        // Operational log WARN was still emitted
        expect(mockLoggerWarn).toHaveBeenCalled();
        const [, fields] = mockLoggerWarn.mock.calls[0] as [
            string,
            Record<string, unknown>,
        ];
        // userId must be scrubbed to avoid enumeration if logs escape
        expect(fields.userId).toBeUndefined();
    });

    it('falls back to logger.warn if the audit write itself throws', async () => {
        mockFindFirst.mockResolvedValue({ tenantId: 'tnt_1' });
        mockAppendAuditEntry.mockRejectedValueOnce(new Error('db down'));

        await expect(
            recordLoginFailure({
                email: 'alice@example.com',
                userId: 'usr_1',
                method: 'credentials',
                reason: 'credentials_invalid',
            }),
        ).resolves.not.toThrow();
        // audit fail path escalates to warn
        expect(mockLoggerWarn.mock.calls.some(([msg]) =>
            String(msg).includes('audit write failed'))).toBe(true);
    });
});

// ── Privacy ────────────────────────────────────────────────────────────

describe('security-events — privacy invariants', () => {
    it('never includes plaintext email in the audit payload (only hash)', async () => {
        mockFindFirst.mockResolvedValue({ tenantId: 'tnt_1' });
        await recordLoginSuccess({
            email: 'alice@example.com',
            userId: 'usr_1',
            method: 'credentials',
        });
        const payload = mockAppendAuditEntry.mock.calls[0][0];
        expect(JSON.stringify(payload)).not.toContain('alice@example.com');
    });

    it('hashEmailForLog is deterministic and case/whitespace-insensitive', () => {
        const a = hashEmailForLog('alice@example.com');
        const b = hashEmailForLog('  ALICE@example.COM  ');
        expect(a).toBe(b);
        expect(a).toMatch(/^[a-f0-9]+$/);
        expect(a.length).toBeGreaterThanOrEqual(8);
    });

    it('a sign-in row carries the deployment KEYED lookup hash, not the old unsalted one (#5950)', async () => {
        mockFindFirst.mockResolvedValue({ tenantId: 'tnt_1' });
        await recordLoginSuccess({ email: 'alice@example.com', userId: 'usr_1', method: 'credentials' });
        const payload = mockAppendAuditEntry.mock.calls[0][0] as {
            detailsJson: { auth: { identifierHash: string } };
        };
        const stored = payload.detailsJson.auth.identifierHash;
        // Equal to `User.emailHash` for the same address: HMAC under the lookup key.
        expect(stored).toBe(hashForLookup('alice@example.com'));
        expect(stored).toMatch(/^[0-9a-f]{64}$/);
        // Not what anybody can compute from a guessed address without the key.
        const unsalted = createHash('sha256').update('alice@example.com').digest('hex');
        expect(stored).not.toBe(unsalted.slice(0, 16));
        expect(stored).not.toBe(unsalted);
        // The log line carries the same value, so a log and a row still correlate.
        const [, fields] = mockLoggerInfo.mock.calls[0] as [string, Record<string, unknown>];
        expect(fields.identifierHash).toBe(stored);
    });
});
