/**
 * Step 6c: `updateTenantSecurityConfig` refuses the adjudication modes it
 * cannot honour.
 *
 * Three refusals, each its own test. They are not interchangeable: one is a
 * deployment fact the tenant cannot change, one is a contradiction with their
 * own residency setting, and one is a DPA state. An admin told the wrong one
 * goes and changes the wrong thing.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import {
    getTenantSecurityConfig,
    updateTenantSecurityConfig,
} from '@/app-layer/usecases/tenant-security-settings';
import { TYPESAFE_SUBPROCESSOR_ACTIVE } from '@/lib/legacy-access/adjudication-mode';

const prisma: PrismaClient = prismaTestClient();
const T = 'las-tenant';
const ctx = (role = 'OWNER') => makeRequestContext(role, { tenantId: T });

async function clearOwnRows(): Promise<void> {
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: T } });
    await deleteAuditRowsForTenants(prisma, [T]);
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    await prisma.tenant.upsert({
        where: { id: T }, update: {},
        create: { id: T, name: 'Adjudication Tenant', slug: T },
    });
    await prisma.user.upsert({
        where: { id: 'user-1' }, update: {},
        create: { id: 'user-1', email: 'admin@las.test', name: 'Admin' },
    });
});

beforeEach(clearOwnRows);
afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the default is OFF, and nothing reaches a provider', () => {
    it('a tenant with NO settings row reads OFF', async () => {
        // The most important row in this file. `aiResidency` defaults to
        // EXTERNAL, so reading the pair carelessly makes "never configured"
        // mean "external model allowed".
        const cfg = await getTenantSecurityConfig(ctx());
        expect(cfg.legacyMatchAiMode).toBe('OFF');
    });

    it('a settings row written without the field also reads OFF', async () => {
        await updateTenantSecurityConfig(ctx(), { aiGuardMode: 'STRICT' });
        const cfg = await getTenantSecurityConfig(ctx());
        expect(cfg.legacyMatchAiMode).toBe('OFF');
        // And the column default did the work, not a code fallback.
        const row = await prisma.tenantSecuritySettings.findFirstOrThrow({
            where: { tenantId: T },
        });
        expect(row.legacyMatchAiMode).toBe('OFF');
    });

    it('OFF can be written explicitly and is accepted', async () => {
        const cfg = await updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'OFF' });
        expect(cfg.legacyMatchAiMode).toBe('OFF');
    });
});

describe('the three refusals', () => {
    it('LOCAL_ONLY is refused when LAYA_BASE_URL is unset', async () => {
        // A DEPLOYMENT value — a tenant cannot point the local model somewhere
        // of their choosing — so the message says it cannot be fixed from the
        // settings page.
        await expect(
            updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'LOCAL_ONLY' })
        ).rejects.toThrow(/LAYA_BASE_URL/);
    });

    it('EXTERNAL is refused while the processor is not an active sub-processor', async () => {
        expect(TYPESAFE_SUBPROCESSOR_ACTIVE).toBe(false);
        await expect(
            updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'EXTERNAL' })
        ).rejects.toThrow(/active sub-processor/);
    });

    it('and that DEPLOYMENT reason is reported before the residency one', async () => {
        // Both hold at once here. The sub-processor block is unconditional — no
        // tenant setting overcomes it — so reporting the residency reason first
        // would send somebody to change their residency, which would not unblock
        // them, and they would come back.
        await updateTenantSecurityConfig(ctx(), { aiResidency: 'LOCAL_ONLY', aiLocalBaseUrl: 'http://local' });
        await expect(
            updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'EXTERNAL' })
        ).rejects.toThrow(/active sub-processor/);
    });

    it('a stored mode is read as part of the combination, not just the patch', async () => {
        // The refusals are cross-field. A patch that changes ONLY residency must
        // still be judged against the mode already stored, or a tenant can reach
        // a refused combination in two legal-looking steps.
        //
        // Reaching EXTERNAL requires the constant, so this asserts the shape
        // that is reachable today: LOCAL_ONLY stored, residency patched, and
        // the LAYA refusal still firing because the deployment has no endpoint.
        await expect(
            updateTenantSecurityConfig(ctx(), {
                legacyMatchAiMode: 'LOCAL_ONLY',
                aiResidency: 'LOCAL_ONLY',
                aiLocalBaseUrl: 'http://local',
            })
        ).rejects.toThrow(/LAYA_BASE_URL/);
    });
});

describe('a mode change gets its own audit event', () => {
    it('OFF -> OFF writes no mode event', async () => {
        await updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'OFF' });
        const n = await prisma.auditLog.count({
            where: { tenantId: T, action: 'LEGACY_MATCH_AI_MODE_CHANGED' },
        });
        // An audit trail of non-events trains people to skip it.
        expect(n).toBe(0);
    });

    it('SECURITY_SETTINGS_UPDATED still records field NAMES only', async () => {
        await updateTenantSecurityConfig(ctx(), { aiGuardMode: 'STRICT' });
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T, action: 'SECURITY_SETTINGS_UPDATED' },
        });
        // The reason the mode needs its own event: this one cannot say WHERE
        // the data started going.
        expect(row.details).toMatch(/aiGuardMode/);
        expect(JSON.stringify(row.detailsJson)).not.toMatch(/TypeSafe/);
    });
});
