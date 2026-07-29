/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts; the file-level disable is the codebase's standard pattern
 * for Prisma/context shims. */

/**
 * Unit coverage for the TenantSecuritySettings WRITE path.
 *
 * The invariants worth pinning here are the ones whose failure modes are
 * silent:
 *
 *   1. PATCH SEMANTICS — an absent key must not be written. This is what keeps
 *      this writer from clobbering `updateTenantMfaPolicy`, which upserts the
 *      SAME ROW and unconditionally writes `sessionMaxAgeMinutes`.
 *   2. THE SECRET IS NEVER RETURNED, and never lands in the audit detail.
 *   3. The secret is stored as PLAINTEXT — the Epic B middleware owns
 *      encryption. Encrypting here would double-encrypt and the streamer would
 *      sign every batch with the wrong key.
 *   4. mfaPolicy is never authored by this path.
 */

const mockDb = {
    tenantSecuritySettings: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

const mockLogEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => mockLogEvent(...a),
}));

import {
    getTenantSecurityConfig,
    updateTenantSecurityConfig,
} from '@/app-layer/usecases/tenant-security-settings';
import { getPermissionsForRole } from '@/lib/permissions';
import { validateAuditDetailsJson } from '@/app-layer/schemas/json-columns.schemas';

function ctxFor(role: 'ADMIN' | 'EDITOR' | 'READER'): any {
    return {
        requestId: 'r-1',
        userId: 'u-1',
        tenantId: 'tenant-1',
        role,
        permissions: {},
        appPermissions: getPermissionsForRole(role),
    };
}

const adminCtx = ctxFor('ADMIN');

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.tenantSecuritySettings.findUnique.mockReset();
    mockDb.tenantSecuritySettings.upsert.mockReset();
    mockLogEvent.mockClear();
    mockDb.tenantSecuritySettings.findUnique.mockResolvedValue(null);
    mockDb.tenantSecuritySettings.upsert.mockResolvedValue({});
});

// ─── Authorization ──────────────────────────────────────────────────

describe('authorization', () => {
    it.each(['EDITOR', 'READER'] as const)('denies %s on read', async (role) => {
        await expect(getTenantSecurityConfig(ctxFor(role))).rejects.toThrow(/ADMIN|OWNER/);
    });

    it.each(['EDITOR', 'READER'] as const)('denies %s on write', async (role) => {
        await expect(
            updateTenantSecurityConfig(ctxFor(role), { mfaFailClosed: true }),
        ).rejects.toThrow(/ADMIN|OWNER/);
        expect(mockDb.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
    });
});

// ─── Patch semantics (the clobber guard) ────────────────────────────

describe('patch semantics', () => {
    it('writes ONLY the keys present in the patch', async () => {
        await updateTenantSecurityConfig(adminCtx, { maxConcurrentSessions: 5 });

        const args = mockDb.tenantSecuritySettings.upsert.mock.calls[0][0];
        expect(Object.keys(args.update)).toEqual(['maxConcurrentSessions']);
        expect(args.update.maxConcurrentSessions).toBe(5);
    });

    it('never authors mfaPolicy or sessionMaxAgeMinutes — the MFA route owns those', async () => {
        await updateTenantSecurityConfig(adminCtx, {
            maxConcurrentSessions: 3,
            mfaFailClosed: true,
        });

        const args = mockDb.tenantSecuritySettings.upsert.mock.calls[0][0];
        for (const shape of [args.update, args.create]) {
            expect(shape).not.toHaveProperty('mfaPolicy');
            expect(shape).not.toHaveProperty('sessionMaxAgeMinutes');
        }
    });

    it('an explicit null CLEARS, and is distinguishable from an absent key', async () => {
        await updateTenantSecurityConfig(adminCtx, { auditStreamUrl: null });
        const args = mockDb.tenantSecuritySettings.upsert.mock.calls[0][0];
        expect(args.update).toHaveProperty('auditStreamUrl', null);
    });

    it('rejects an empty patch rather than writing nothing and reporting success', async () => {
        await expect(updateTenantSecurityConfig(adminCtx, {})).rejects.toThrow(/No settings/);
        expect(mockDb.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
    });
});

// ─── Validation ─────────────────────────────────────────────────────

describe('validation', () => {
    it.each([0, -1, 101, 1.5])('rejects maxConcurrentSessions=%s', async (v) => {
        await expect(
            updateTenantSecurityConfig(adminCtx, { maxConcurrentSessions: v as number }),
        ).rejects.toThrow(/between 1 and 100/);
    });

    it('accepts null maxConcurrentSessions as "unlimited"', async () => {
        await expect(
            updateTenantSecurityConfig(adminCtx, { maxConcurrentSessions: null }),
        ).resolves.toBeDefined();
    });

    it.each([
        ['http://example.com/hook', 'plain http'],
        ['https://169.254.169.254/latest/meta-data/', 'cloud metadata'],
        ['https://127.0.0.1/hook', 'loopback'],
        ['https://10.0.0.5/hook', 'private range'],
    ])('rejects audit stream URL %s (%s)', async (url) => {
        await expect(
            updateTenantSecurityConfig(adminCtx, { auditStreamUrl: url }),
        ).rejects.toThrow(/Audit stream URL rejected/);
        expect(mockDb.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
    });

    it('accepts a public https audit stream URL when a secret is already stored', async () => {
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValue({
            aiResidency: 'EXTERNAL',
            aiLocalBaseUrl: null,
            auditStreamUrl: null,
            auditStreamSecretEncrypted: 'an-already-stored-secret',
        });
        await expect(
            updateTenantSecurityConfig(adminCtx, { auditStreamUrl: 'https://siem.example.com/ingest' }),
        ).resolves.toBeDefined();
    });

    it('refuses a stream URL with no secret — the streamer would discard every event', async () => {
        await expect(
            updateTenantSecurityConfig(adminCtx, { auditStreamUrl: 'https://siem.example.com/ingest' }),
        ).rejects.toThrow(/requires auditStreamSecret/);
    });

    it('rejects a too-short audit stream secret', async () => {
        await expect(
            updateTenantSecurityConfig(adminCtx, { auditStreamSecret: 'short' }),
        ).rejects.toThrow(/at least 16/);
    });

    it('refuses LOCAL_ONLY residency with no gateway configured', async () => {
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValue({
            aiResidency: 'EXTERNAL',
            aiLocalBaseUrl: null,
        });
        await expect(
            updateTenantSecurityConfig(adminCtx, { aiResidency: 'LOCAL_ONLY' }),
        ).rejects.toThrow(/requires aiLocalBaseUrl/);
    });

    it('allows LOCAL_ONLY when the gateway is already stored', async () => {
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValue({
            aiResidency: 'EXTERNAL',
            aiLocalBaseUrl: 'https://gpu.internal.example.com',
        });
        await expect(
            updateTenantSecurityConfig(adminCtx, { aiResidency: 'LOCAL_ONLY' }),
        ).resolves.toBeDefined();
    });
});

// ─── Secret handling ────────────────────────────────────────────────

describe('audit stream secret', () => {
    it('is stored as PLAINTEXT — the Epic B middleware owns encryption', async () => {
        const secret = 'a-sufficiently-long-secret'; // pragma: allowlist secret -- unit-test input, not a credential
        await updateTenantSecurityConfig(adminCtx, { auditStreamSecret: secret });

        const args = mockDb.tenantSecuritySettings.upsert.mock.calls[0][0];
        expect(args.update.auditStreamSecretEncrypted).toBe(secret);
    });

    it('is NEVER returned by a read — only its presence is', async () => {
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValue({
            maxConcurrentSessions: 5,
            auditStreamUrl: 'https://siem.example.com/ingest',
            auditStreamSecretEncrypted: 'the-real-secret-value',
            aiGuardMode: 'BALANCED',
            aiResidency: 'EXTERNAL',
            aiLocalBaseUrl: null,
            aiLocalModel: null,
            mfaFailClosed: false,
        });

        const cfg = await getTenantSecurityConfig(adminCtx);
        expect(cfg.hasAuditStreamSecret).toBe(true);
        expect(JSON.stringify(cfg)).not.toContain('the-real-secret-value');
        expect(cfg).not.toHaveProperty('auditStreamSecretEncrypted');
    });

    it('the audit payload passes the REAL detailsJson validator', async () => {
        // This test exists because mocking `logEvent` hid a blocking bug: the
        // first version sent `category: 'configuration'`, which is not in the
        // enum at json-columns.schemas.ts:28-35. `validateAuditDetailsJson`
        // THROWS on an unknown category, and the `logEvent` call is awaited
        // inside the `runInTenantContext` transaction — so every valid save
        // rolled back and returned 400. Every other test in this file passed,
        // because they all mock the thing that would have failed.
        //
        // Running the real validator over the real emitted payload is the only
        // assertion here that could have caught it.
        await updateTenantSecurityConfig(adminCtx, { mfaFailClosed: true });
        const payload = mockLogEvent.mock.calls[0][2] as any;
        expect(() => validateAuditDetailsJson(payload.detailsJson)).not.toThrow();
    });

    it('never lands in the audit detail — field NAMES only', async () => {
        const secret = 'another-long-enough-secret'; // pragma: allowlist secret -- unit-test input, not a credential
        await updateTenantSecurityConfig(adminCtx, {
            auditStreamSecret: secret,
            auditStreamUrl: 'https://siem.example.com/ingest',
        });

        const payload = mockLogEvent.mock.calls[0][2] as any;
        expect(payload.action).toBe('SECURITY_SETTINGS_UPDATED');
        expect(payload.detailsJson.changedFields).toEqual(
            expect.arrayContaining(['auditStreamUrl', 'auditStreamSecret']),
        );
        const serialised = JSON.stringify(payload);
        expect(serialised).not.toContain(secret);
        expect(serialised).not.toContain('siem.example.com');
    });
});
