/**
 * `getPrivacyPosture` — the read-only privacy/data-protection aggregate
 * behind `/admin/privacy`.
 *
 * The assertions that matter most here are the NEGATIVE ones. This page is on
 * a compliance product, so a flag that flips from false to true silently would
 * make the UI claim a capability the backend does not have. `dsar.intakeEnabled`
 * and `retention.tenantConfigurable` are pinned false, and
 * `residency.declarativeOnly` pinned true, precisely so that wiring the real
 * feature forces a deliberate change here.
 */

const mockDb = {
    tenant: { findUnique: jest.fn() },
    tenantSecuritySettings: { findUnique: jest.fn() },
    evidence: { count: jest.fn() },
    vendor: { count: jest.fn() },
    vendorRelationship: { count: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) => fn(mockDb),
    ),
}));

const mockAssert = jest.fn();
jest.mock('@/app-layer/policies/admin.policies', () => ({
    assertCanViewAdminSettings: (...a: unknown[]) => mockAssert(...a),
}));

import { getPrivacyPosture } from '@/app-layer/usecases/privacy-posture';
import { makeRequestContext } from '../helpers/make-context';

function seed(overrides: {
    tenant?: Record<string, unknown> | null;
    auditStreamUrl?: string | null;
    evidenceCount?: number;
    vendorCount?: number;
    relationshipCount?: number;
} = {}) {
    mockDb.tenant.findUnique.mockResolvedValue(
        overrides.tenant === undefined
            ? { region: 'US_EAST_1', encryptedDek: 'wrapped', previousEncryptedDek: null }
            : overrides.tenant,
    );
    mockDb.tenantSecuritySettings.findUnique.mockResolvedValue(
        overrides.auditStreamUrl === undefined ? null : { auditStreamUrl: overrides.auditStreamUrl },
    );
    mockDb.evidence.count.mockResolvedValue(overrides.evidenceCount ?? 0);
    mockDb.vendor.count.mockResolvedValue(overrides.vendorCount ?? 0);
    mockDb.vendorRelationship.count.mockResolvedValue(overrides.relationshipCount ?? 0);
}

beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks resets recorded calls but NOT implementations, so the
    // throwing policy stub from the denial test would leak into whatever runs
    // next. Reset it back to a permissive no-op explicitly.
    mockAssert.mockReset();
});

describe('getPrivacyPosture — capability flags stay honest', () => {
    it('reports the DSAR register as available but fulfilment as NOT automated', async () => {
        seed();
        const res = await getPrivacyPosture(makeRequestContext('ADMIN'));
        // Intake flipped true when the manual register landed. Fulfilment did
        // NOT, and Stage 3 (#2287) did not change that: jobs/dsar-export.ts
        // still throws, and while dsar-erasure.ts::eraseUser now executes it is
        // unregistered and uncalled, so nothing in the product can reach it.
        // The two flags stay separate so the page cannot imply
        // an export/erasure pipeline just because requests can be recorded —
        // collapsing them into one "DSAR works" boolean is the exact
        // overstatement this assertion exists to prevent.
        expect(res.dsar.intakeEnabled).toBe(true);
        expect(res.dsar.automatedFulfilment).toBe(false);
    });

    it('reports retention as NOT tenant-configurable', async () => {
        seed();
        const res = await getPrivacyPosture(makeRequestContext('ADMIN'));
        expect(res.retention.tenantConfigurable).toBe(false);
        expect(res.retention.softDeleteGraceDays).toBe(90);
        expect(res.retention.evidencePurgeDays).toBe(365);
    });

    it('marks residency as declarative even for a provisioned region', async () => {
        seed({ tenant: { region: 'US_EAST_1', encryptedDek: 'w', previousEncryptedDek: null } });
        const res = await getPrivacyPosture(makeRequestContext('ADMIN'));
        expect(res.residency.provisioned).toBe(true);
        // Provisioned infrastructure still does not mean residency is enforced.
        expect(res.residency.declarativeOnly).toBe(true);
    });

    it('flags a declared-but-unprovisioned region as not provisioned', async () => {
        seed({ tenant: { region: 'EU_WEST_1', encryptedDek: 'w', previousEncryptedDek: null } });
        const res = await getPrivacyPosture(makeRequestContext('ADMIN'));
        expect(res.residency.region).toBe('EU_WEST_1');
        expect(res.residency.provisioned).toBe(false);
    });
});

describe('getPrivacyPosture — observed state', () => {
    it('derives encryption state from the wrapped DEK columns', async () => {
        seed({ tenant: { region: 'US_EAST_1', encryptedDek: 'wrapped', previousEncryptedDek: 'older' } });
        const res = await getPrivacyPosture(makeRequestContext('ADMIN'));
        expect(res.encryption).toEqual({ perTenantDek: true, rotationInFlight: true });
    });

    it('treats a tenant without a DEK as global-key-only, not an error', async () => {
        seed({ tenant: { region: 'US_EAST_1', encryptedDek: null, previousEncryptedDek: null } });
        const res = await getPrivacyPosture(makeRequestContext('ADMIN'));
        expect(res.encryption.perTenantDek).toBe(false);
        expect(res.encryption.rotationInFlight).toBe(false);
    });

    it('reports audit streaming only when a destination URL is set', async () => {
        seed({ auditStreamUrl: 'https://siem.example/ingest' });
        await expect(getPrivacyPosture(makeRequestContext('ADMIN'))).resolves.toMatchObject({
            auditStream: { configured: true },
        });

        jest.clearAllMocks();
        seed({ auditStreamUrl: null });
        await expect(getPrivacyPosture(makeRequestContext('ADMIN'))).resolves.toMatchObject({
            auditStream: { configured: false },
        });
    });

    it('counts sub-processors and retention-ruled evidence', async () => {
        seed({ evidenceCount: 12, vendorCount: 7, relationshipCount: 9 });
        const res = await getPrivacyPosture(makeRequestContext('ADMIN'));
        expect(res.subProcessors).toEqual({ flaggedVendorCount: 7, relationshipCount: 9 });
        expect(res.retention.evidenceWithRetentionRule).toBe(12);
    });

    it('falls back to the default region when the tenant row is missing', async () => {
        seed({ tenant: null });
        const res = await getPrivacyPosture(makeRequestContext('ADMIN'));
        expect(res.residency.region).toBe('US_EAST_1');
        expect(res.encryption.perTenantDek).toBe(false);
    });
});

describe('getPrivacyPosture — authorization + tenant scoping', () => {
    it('asserts admin-settings permission before reading anything', async () => {
        seed();
        await getPrivacyPosture(makeRequestContext('ADMIN'));
        expect(mockAssert).toHaveBeenCalledTimes(1);
    });

    it('propagates a policy denial instead of returning a partial posture', async () => {
        seed();
        mockAssert.mockImplementation(() => {
            throw new Error('forbidden');
        });
        await expect(getPrivacyPosture(makeRequestContext('ADMIN'))).rejects.toThrow('forbidden');
        expect(mockDb.tenant.findUnique).not.toHaveBeenCalled();
    });

    it('scopes every count to the request tenant', async () => {
        seed();
        const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-xyz' });
        await getPrivacyPosture(ctx);

        expect(mockDb.evidence.count).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-xyz' }) }),
        );
        expect(mockDb.vendor.count).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-xyz' }) }),
        );
        expect(mockDb.vendorRelationship.count).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-xyz' }) }),
        );
        expect(mockDb.tenant.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'tenant-xyz' } }),
        );
    });
});
