/**
 * PR-5 — device posture checks (null→NOT_APPLICABLE), device-token auth
 * (generate/hash/verify), report + token-lifecycle usecases, device provider.
 */
jest.mock('@/lib/prisma', () => ({
    prisma: {
        tenantDeviceToken: { findUnique: jest.fn(), update: jest.fn() },
        tenant: { findUnique: jest.fn() },
        device: { findMany: jest.fn() },
    },
    default: { tenantDeviceToken: {}, tenant: {}, device: {} },
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { runDeviceCheck, type CheckDevice } from '@/app-layer/integrations/providers/device/checks';
import { DeviceProvider } from '@/app-layer/integrations/providers/device';
import { generateDeviceToken, hashDeviceToken, verifyDeviceToken } from '@/lib/auth/device-token-auth';
import { reportDevice, issueDeviceToken, revokeDeviceToken, listDevices } from '@/app-layer/usecases/device';
import { prisma } from '@/lib/prisma';
import { makeRequestContext } from '../helpers/make-context';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const mPrisma = prisma as unknown as { tenantDeviceToken: { findUnique: jest.Mock; update: jest.Mock }; tenant: { findUnique: jest.Mock } };

const mockDb = {
    // H3 — reportDevice checks findUnique + count (new-device cap) before upsert.
    device: { upsert: jest.fn(), findMany: jest.fn(), findUnique: jest.fn().mockResolvedValue({ id: 'existing' }), count: jest.fn().mockResolvedValue(0) },
    tenantDeviceToken: { create: jest.fn(), updateMany: jest.fn() },
};

function dev(over: Partial<CheckDevice>): CheckDevice {
    return { serialNumber: over.serialNumber ?? 'SN1', hostname: over.hostname ?? 'h1', platform: over.platform ?? 'MACOS', diskEncrypted: over.diskEncrypted ?? null, screenLockEnabled: over.screenLockEnabled ?? null, antivirusRunning: over.antivirusRunning ?? null, passwordManagerPresent: over.passwordManagerPresent ?? null };
}

describe('runDeviceCheck', () => {
    it('devices_encrypted FAILs a device with diskEncrypted=false', () => {
        const r = runDeviceCheck('devices_encrypted', [dev({ diskEncrypted: true }), dev({ diskEncrypted: false })], NOW);
        expect(r.status).toBe('FAILED');
        expect(r.details.failed).toBe(1);
        expect(r.details.passed).toBe(1);
    });

    it('null (NOT_APPLICABLE) is neither pass nor fail', () => {
        const r = runDeviceCheck('devices_screenlock', [dev({ screenLockEnabled: null }), dev({ screenLockEnabled: true })], NOW);
        expect(r.status).toBe('PASSED');
        expect(r.details.notApplicable).toBe(1);
        expect(r.details.passed).toBe(1);
        expect(r.details.failed).toBe(0);
    });

    it('all-null is NOT_APPLICABLE (H2 — no applicable population, never a false PASS)', () => {
        const r = runDeviceCheck('devices_antivirus', [dev({ antivirusRunning: null })], NOW);
        expect(r.status).toBe('NOT_APPLICABLE');
    });

    it('unknown check ERRORs', () => {
        expect(runDeviceCheck('nope', [], NOW).status).toBe('ERROR');
    });
});

describe('device-token auth', () => {
    it('generateDeviceToken → hashDeviceToken round-trips + prefix format', () => {
        const { plaintext, tokenHash, tokenPrefix } = generateDeviceToken();
        expect(plaintext.startsWith('icdt_')).toBe(true);
        expect(hashDeviceToken(plaintext)).toBe(tokenHash);
        expect(plaintext.startsWith(tokenPrefix)).toBe(true);
    });

    it('verifyDeviceToken rejects wrong format / not-found / revoked / expired', async () => {
        expect((await verifyDeviceToken('nope')).reason).toBe('invalid_format');
        mPrisma.tenantDeviceToken.findUnique.mockResolvedValueOnce(null);
        expect((await verifyDeviceToken('icdt_x')).reason).toBe('not_found');
        mPrisma.tenantDeviceToken.findUnique.mockResolvedValueOnce({ id: 't', tenantId: 'T', expiresAt: null, revokedAt: NOW });
        expect((await verifyDeviceToken('icdt_x')).reason).toBe('revoked');
        mPrisma.tenantDeviceToken.findUnique.mockResolvedValueOnce({ id: 't', tenantId: 'T', expiresAt: new Date('2020-01-01'), revokedAt: null });
        expect((await verifyDeviceToken('icdt_x', null, NOW)).reason).toBe('expired');
    });

    it('verifyDeviceToken accepts a live token + touches lastUsedAt', async () => {
        mPrisma.tenantDeviceToken.findUnique.mockResolvedValueOnce({ id: 'tok-1', tenantId: 'T1', expiresAt: null, revokedAt: null });
        mPrisma.tenantDeviceToken.update.mockResolvedValueOnce({});
        const r = await verifyDeviceToken('icdt_x', '1.2.3.4', NOW);
        expect(r).toMatchObject({ valid: true, tenantId: 'T1', tokenId: 'tok-1' });
        expect(mPrisma.tenantDeviceToken.update).toHaveBeenCalled();
    });
});

describe('device usecases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.device.upsert.mockResolvedValue({ id: 'd1', serialNumber: 'SN1' });
        mockDb.tenantDeviceToken.create.mockResolvedValue({ id: 'tk1', name: 'CI', tokenPrefix: 'icdt_abc', createdAt: NOW });
        mockDb.tenantDeviceToken.updateMany.mockResolvedValue({ count: 1 });
    });

    it('reportDevice upserts by (tenantId, serialNumber) with source AGENT', async () => {
        await reportDevice('T1', { serialNumber: 'SN1', platform: 'MACOS', diskEncrypted: true }, NOW);
        const call = mockDb.device.upsert.mock.calls[0][0];
        expect(call.where.tenantId_serialNumber).toEqual({ tenantId: 'T1', serialNumber: 'SN1' });
        expect(call.create.source).toBe('AGENT');
        expect(call.create.diskEncrypted).toBe(true);
    });

    it('H3 — reportDevice rejects a NEW device once the per-tenant cap is reached', async () => {
        mockDb.device.findUnique.mockResolvedValueOnce(null); // brand-new serial
        mockDb.device.count.mockResolvedValueOnce(10000); // at cap
        await expect(reportDevice('T1', { serialNumber: 'NEW', platform: 'MACOS' }, NOW)).rejects.toThrow(/limit reached/i);
        expect(mockDb.device.upsert).not.toHaveBeenCalled();
    });

    it('H3 — reportDevice still accepts a report for an EXISTING device at the cap', async () => {
        mockDb.device.findUnique.mockResolvedValueOnce({ id: 'existing' }); // known serial
        await reportDevice('T1', { serialNumber: 'SN1', platform: 'MACOS' }, NOW);
        expect(mockDb.device.count).not.toHaveBeenCalled(); // no cap check for updates
        expect(mockDb.device.upsert).toHaveBeenCalled();
    });

    it('issueDeviceToken returns a plaintext once (manage permission)', async () => {
        const ctx = makeRequestContext('ADMIN');
        const token = await issueDeviceToken(ctx, { name: 'CI' });
        expect(token.plaintext.startsWith('icdt_')).toBe(true);
        expect(mockDb.tenantDeviceToken.create).toHaveBeenCalled();
    });

    it('issueDeviceToken forbids a reader', async () => {
        const ctx = makeRequestContext('READER');
        await expect(issueDeviceToken(ctx, { name: 'CI' })).rejects.toThrow(/permission/i);
    });

    it('revokeDeviceToken sets revokedAt', async () => {
        const ctx = makeRequestContext('ADMIN');
        const r = await revokeDeviceToken(ctx, 'tk1', NOW);
        expect(r.revoked).toBe(true);
        expect(mockDb.tenantDeviceToken.updateMany.mock.calls[0][0].data.revokedAt).toBe(NOW);
    });

    it('listDevices is tenant-scoped', async () => {
        mockDb.device.findMany.mockResolvedValue([]);
        const ctx = makeRequestContext('READER');
        await listDevices(ctx);
        expect(mockDb.device.findMany.mock.calls[0][0].where.tenantId).toBe(ctx.tenantId);
    });
});

describe('DeviceProvider', () => {
    /** The `CheckInput` every test here passes; only the check type varies. */
    const inputFor = (checkType: string) => ({
        automationKey: `device.${checkType}`,
        parsed: { provider: 'device', checkType, raw: '' },
        tenantId: 'T1',
        connectionConfig: {},
        triggeredBy: 'scheduled' as const,
    });

    it('runCheck applies the check to injected devices', async () => {
        const provider = new DeviceProvider({ load: async () => [dev({ diskEncrypted: false })], now: () => NOW });
        const r = await provider.runCheck({ automationKey: 'device.devices_encrypted', parsed: { provider: 'device', checkType: 'devices_encrypted', raw: '' }, tenantId: 'T1', connectionConfig: {}, triggeredBy: 'scheduled' });
        expect(r.status).toBe('FAILED');
        expect(provider.supportedChecks).toContain('devices_encrypted');
    });

    /**
     * ═══ runCheck NEVER MANUFACTURES A SIGNAL (#3647) ═══
     *
     * Every test above this block injects `deps.load`, so until now no test had
     * seen this provider FAIL — the `catch` arm and the `mapResultToEvidence`
     * suppression were both entirely unexecuted.
     *
     * They are the two things standing between a failed check and a check that
     * reports as having run. These rows feed the controls the 05:00 pass acts
     * on, so a green signal this provider has not earned is the harmful
     * direction, and `ERROR` is the only honest answer when the load threw.
     */
    describe('a load that throws is an ERROR, never a verdict', () => {
        it('reports ERROR — not PASSED, and not NOT_APPLICABLE either', async () => {
            // NOT_APPLICABLE is the subtler wrong answer: it reads as
            // "assessed, does not apply" rather than "never assessed", and a
            // control showing it looks deliberately out of scope.
            const provider = new DeviceProvider({
                load: async () => {
                    throw new Error('device table unreachable');
                },
                now: () => NOW,
            });

            const r = await provider.runCheck(inputFor('devices_encrypted'));

            expect(r.status).toBe('ERROR');
            expect(r.status).not.toBe('PASSED');
            expect(r.status).not.toBe('NOT_APPLICABLE');
            expect(r.status).not.toBe('FAILED');
        });

        it('carries the cause in errorMessage, and no device details', async () => {
            const provider = new DeviceProvider({
                load: async () => {
                    throw new Error('device table unreachable');
                },
            });

            const r = await provider.runCheck(inputFor('devices_encrypted'));

            expect(r.errorMessage).toBe('device table unreachable');
            // `details: {}` — an ERROR has no population, so it must not carry
            // passed/failed counts a reader would take for a measurement.
            expect(r.details).toEqual({});
        });

        it('stringifies a throw that is not an Error', async () => {
            // `err instanceof Error ? err.message : String(err)`. A rejected
            // promise carrying a string loses its cause entirely if this arm
            // is wrong, and the operator gets an ERROR with no reason.
            const provider = new DeviceProvider({
                load: async () => {
                    throw 'raw string failure';
                },
            });

            const r = await provider.runCheck(inputFor('devices_encrypted'));

            expect(r.status).toBe('ERROR');
            expect(r.errorMessage).toBe('raw string failure');
        });
    });

    describe('mapResultToEvidence suppresses an ERROR', () => {
        it('returns null, so a failed run files no evidence', async () => {
            // Evidence is what an auditor reads. Filing a row for a check that
            // errored would put a document in the trail asserting a posture
            // nobody measured.
            const provider = new DeviceProvider();
            const evidence = provider.mapResultToEvidence(inputFor('devices_encrypted'), {
                status: 'ERROR',
                summary: 'Device check failed to run.',
                details: {},
                durationMs: 1,
                errorMessage: 'boom',
            });

            expect(evidence).toBeNull();
        });

        it('and files it for a real verdict — the positive control', async () => {
            // Without this, the assertion above is satisfied by a function that
            // returns null for everything, which would silently stop all device
            // evidence rather than only the errored ones.
            const provider = new DeviceProvider();
            const evidence = provider.mapResultToEvidence(inputFor('devices_encrypted'), {
                status: 'PASSED',
                summary: '3 of 3 devices encrypted.',
                details: {},
                durationMs: 1,
            });

            expect(evidence).not.toBeNull();
            expect(evidence?.category).toBe('device:devices_encrypted');
            expect(evidence?.content).toBe('3 of 3 devices encrypted.');
        });
    });

    describe('with no injected loader it reads the tenant\'s own rows', () => {
        it('scopes the query to the tenant and clamps the row count', async () => {
            // The production path, which no test had taken: every other test
            // supplies `deps.load`, so `prisma.device.findMany` had never been
            // called. Both halves matter — an unscoped `where` reads another
            // tenant's devices, and a missing `take` lets one tenant's
            // inventory exhaust the check's memory.
            const findMany = (prisma as unknown as { device: { findMany: jest.Mock } }).device.findMany;
            findMany.mockReset();
            findMany.mockResolvedValue([dev({ diskEncrypted: true })]);

            const provider = new DeviceProvider({ now: () => NOW });
            const r = await provider.runCheck(inputFor('devices_encrypted'));

            expect(findMany).toHaveBeenCalledTimes(1);
            const arg = findMany.mock.calls[0][0] as { where: { tenantId: string }; take: number };
            expect(arg.where.tenantId).toBe('T1');
            expect(arg.take).toBe(10000);
            // And the rows it returned actually reached the check.
            expect(r.status).toBe('PASSED');
        });

        it('uses the real clock when no `now` is injected', async () => {
            // `this.deps.now ? this.deps.now() : new Date()`. The else arm had
            // never run, so nothing proved the provider works at all outside a
            // test that pins the clock.
            const findMany = (prisma as unknown as { device: { findMany: jest.Mock } }).device.findMany;
            findMany.mockReset();
            findMany.mockResolvedValue([dev({ diskEncrypted: true })]);

            const r = await new DeviceProvider().runCheck(inputFor('devices_encrypted'));

            expect(r.status).toBe('PASSED');
            expect(r.durationMs).toBeGreaterThanOrEqual(0);
        });
    });
});
