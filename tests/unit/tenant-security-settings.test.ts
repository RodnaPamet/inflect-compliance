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
    // The recertification-owner write checks the nominee actually holds a seat
    // before storing the id — see the suite at the end of this file for why a
    // bare store would be settable and inert.
    tenantMembership: {
        findUnique: jest.fn(),
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
import { UpdateTenantSecuritySettingsInput } from '@/app-layer/schemas/tenant-security-settings.schemas';

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

/**
 * `recertificationOwnerUserId` — the name this product acts under when it
 * raises a review nobody asked for (#2879 f58).
 *
 * ═══ WHY THE WRITE VALIDATES AND DOES NOT JUST STORE ═══
 *
 * `agent-driver-column-has-a-writer` names the failure this column could
 * otherwise repeat: "settable and inert". An id that resolves to nobody stores
 * cleanly, reads back cleanly, and then raises nothing forever — while the
 * tenant believes automated recertification is on. `resolveMemberContext`
 * would refuse it at RUN time, months later, on a night nobody is watching.
 * Refusing at the moment somebody types it is the only place that can say so.
 */
describe('recertificationOwnerUserId', () => {
    const OWNER = 'clw0000000000000000000000';

    beforeEach(() => {
        mockDb.tenantSecuritySettings.upsert.mockResolvedValue({});
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValue({});
    });

    it('stores an id that names an ACTIVE member', async () => {
        mockDb.tenantMembership.findUnique.mockResolvedValue({ status: 'ACTIVE' });

        await updateTenantSecurityConfig(ctxFor('ADMIN'), { recertificationOwnerUserId: OWNER });

        const written = mockDb.tenantSecuritySettings.upsert.mock.calls.at(-1)?.[0];
        expect(written.update.recertificationOwnerUserId).toBe(OWNER);
    });

    it('REFUSES an id that names nobody', async () => {
        mockDb.tenantMembership.findUnique.mockResolvedValue(null);

        await expect(
            updateTenantSecurityConfig(ctxFor('ADMIN'), { recertificationOwnerUserId: OWNER }),
        ).rejects.toThrow(/ACTIVE member/i);
        expect(mockDb.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
    });

    it.each(['INVITED', 'DEACTIVATED', 'REMOVED'])(
        'REFUSES a member whose status is %s — a bare existence test would pass it',
        async (status) => {
            // These are exactly the rows that clear "does a membership exist"
            // and then fail `resolveMemberContext`, which accepts ACTIVE only.
            mockDb.tenantMembership.findUnique.mockResolvedValue({ status });

            await expect(
                updateTenantSecurityConfig(ctxFor('ADMIN'), { recertificationOwnerUserId: OWNER }),
            ).rejects.toThrow(/ACTIVE member/i);
        },
    );

    it('clears with null WITHOUT looking anybody up', async () => {
        // Turning it off must not depend on the departing nominee still being
        // resolvable — that would make a setting you cannot switch off once
        // the person it names has gone.
        await updateTenantSecurityConfig(ctxFor('ADMIN'), { recertificationOwnerUserId: null });

        expect(mockDb.tenantMembership.findUnique).not.toHaveBeenCalled();
        const written = mockDb.tenantSecuritySettings.upsert.mock.calls.at(-1)?.[0];
        expect(written.update.recertificationOwnerUserId).toBeNull();
    });

    it('is not written at all when the key is absent — patch semantics', async () => {
        // The invariant this whole file exists for: this writer shares a row
        // with `updateTenantMfaPolicy`, so an absent key that got written would
        // clobber a value the caller never mentioned.
        await updateTenantSecurityConfig(ctxFor('ADMIN'), { mfaFailClosed: true });

        const written = mockDb.tenantSecuritySettings.upsert.mock.calls.at(-1)?.[0];
        expect(written.update).not.toHaveProperty('recertificationOwnerUserId');
    });
});

/**
 * `apiKeyRotationDays` — the rotation age credential hygiene applies (#3708).
 *
 * Three layers refuse an out-of-range value: the route's schema, this usecase
 * and the DB CHECK (proved in tests/integration/tenant-api-key-rotation-age.test.ts).
 * The audit event is its own, with both values, because the general event
 * records field names only.
 */
describe('apiKeyRotationDays', () => {
    const rotationEvent = () =>
        mockLogEvent.mock.calls.map((c) => c[2] as any).find((p) => p.action === 'API_KEY_ROTATION_AGE_CHANGED');

    it('the schema accepts 7..730 and null, and refuses anything else', () => {
        for (const ok of [7, 30, 90, 730, null]) {
            expect(UpdateTenantSecuritySettingsInput.safeParse({ apiKeyRotationDays: ok }).success).toBe(true);
        }
        for (const bad of [6, 731, 0, -30, 30.5, '30', true]) {
            const r = UpdateTenantSecuritySettingsInput.safeParse({ apiKeyRotationDays: bad });
            expect({ bad, success: r.success }).toEqual({ bad, success: false });
        }
        const refused = UpdateTenantSecuritySettingsInput.safeParse({ apiKeyRotationDays: 3 });
        expect(refused.success ? '' : refused.error.issues[0]?.message).toMatch(/from 7 to 730, or null/);
    });

    it('writes only the key it was given, as a value or as an explicit null', async () => {
        await updateTenantSecurityConfig(adminCtx, { apiKeyRotationDays: 30 });
        expect(mockDb.tenantSecuritySettings.upsert.mock.calls[0][0].update).toEqual({ apiKeyRotationDays: 30 });

        await updateTenantSecurityConfig(adminCtx, { apiKeyRotationDays: null });
        expect(mockDb.tenantSecuritySettings.upsert.mock.calls[1][0].update).toEqual({ apiKeyRotationDays: null });
    });

    it.each([6, 731, 30.5])('the usecase refuses %s before anything is written', async (bad) => {
        await expect(updateTenantSecurityConfig(adminCtx, { apiKeyRotationDays: bad })).rejects.toThrow(
            /from 7 to 730/,
        );
        expect(mockDb.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it.each(['EDITOR', 'READER'] as const)('%s cannot set it', async (role) => {
        await expect(updateTenantSecurityConfig(ctxFor(role), { apiKeyRotationDays: 30 })).rejects.toThrow(
            /ADMIN|OWNER/,
        );
        expect(mockDb.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
    });

    it('a change writes its own audit event naming the old and new value, which passes the real validator', async () => {
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValue({ apiKeyRotationDays: null });
        await updateTenantSecurityConfig(adminCtx, { apiKeyRotationDays: 30 });

        const event = rotationEvent();
        expect(event).toMatchObject({
            entityType: 'TenantSecuritySettings',
            entityId: 'tenant-1',
            detailsJson: {
                before: { apiKeyRotationDays: null, effectiveDays: 90, source: 'DEFAULT_NO_TENANT_SETTING' },
                after: { apiKeyRotationDays: 30, effectiveDays: 30, source: 'TENANT_SETTING' },
            },
        });
        expect(event.details).toBe(
            'API-key rotation age changed from 90 days (DEFAULT_NO_TENANT_SETTING) to 30 days (TENANT_SETTING)',
        );
        expect(() => validateAuditDetailsJson(event.detailsJson)).not.toThrow();
    });

    it('a PUT that leaves the value where it was writes no rotation event', async () => {
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValue({ apiKeyRotationDays: 30 });
        await updateTenantSecurityConfig(adminCtx, { apiKeyRotationDays: 30 });
        expect(rotationEvent()).toBeUndefined();
    });

    it('is reported on read, null meaning the product default', async () => {
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValue(null);
        expect((await getTenantSecurityConfig(adminCtx)).apiKeyRotationDays).toBeNull();
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValue({ apiKeyRotationDays: 45 });
        expect((await getTenantSecurityConfig(adminCtx)).apiKeyRotationDays).toBe(45);
    });
});
