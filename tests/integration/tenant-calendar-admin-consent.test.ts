/**
 * The Microsoft organisation-wide calendar authorisation against the real
 * database (#5937 step 3): what the consent card reads, and what the audit
 * trail keeps when an authorisation completes, fails or is revoked.
 *
 *   - The card's read names the granting member (an encrypted column, read
 *     back through the encryption extension) and the directory, per workspace.
 *   - Another workspace's grant is not this workspace's.
 *   - A failed authorisation leaves one hash-chained access row carrying the
 *     outcome and Entra's bare codes, never Microsoft's description.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { hashForLookup } from '@/lib/security/encryption';
import {
    getAdminConsentOverview,
    recordAdminConsent,
    recordAdminConsentFailure,
    revokeAdminConsent,
} from '@/app-layer/usecases/tenant-calendar-consent';

const d = DB_AVAILABLE ? describe : describe.skip;

const DIRECTORY = '72f988bf-86f1-41af-91ab-2d7cd011db47';

d('tenant calendar admin consent — the card\'s read and the audit trail', () => {
    const prisma = prismaTestClient();
    const tenantIds: string[] = [];

    async function fixture(label: string) {
        const slug = `calcons-${label}-${Date.now()}`;
        const tenant = await createTenantWithDek({ name: slug, slug });
        const email = `${slug}@example.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email), name: `Admin ${label}` } });
        tenantIds.push(tenant.id);
        const ctx = makeRequestContext('ADMIN', { tenantId: tenant.id, userId: user.id, tenantSlug: slug });
        return { tenant, user, ctx, email };
    }

    afterAll(async () => {
        // Only the consent rows; tenants, users and their audit rows are left
        // for `resetDatabase`, as the sibling calendar suites do (#3343).
        await prisma.tenantCalendarConsent.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.$disconnect();
    });

    it('a grant reads back with who, when and which directory; another workspace sees none of it', async () => {
        const a = await fixture('a');
        const b = await fixture('b');

        await recordAdminConsent(a.ctx, { provider: 'outlook-calendar', externalTenantId: DIRECTORY });

        const [mine] = await getAdminConsentOverview(a.ctx);
        expect(mine).toMatchObject({
            provider: 'outlook-calendar',
            granted: true,
            revokedAt: null,
            externalTenantId: DIRECTORY,
            grantedBy: { name: 'Admin a', email: a.email },
        });
        expect(mine.grantedAt).toBeInstanceOf(Date);

        const [theirs] = await getAdminConsentOverview(b.ctx);
        expect(theirs).toMatchObject({ granted: false, grantedAt: null, grantedBy: null, externalTenantId: null });
    }, 30_000);

    it('a revocation reads back as revoked, keeping when and by whom it was granted', async () => {
        const { ctx, email } = await fixture('revoke');
        await recordAdminConsent(ctx, { provider: 'outlook-calendar', externalTenantId: DIRECTORY });
        await revokeAdminConsent(ctx, 'outlook-calendar', 'withdrawn by administrator');

        const [state] = await getAdminConsentOverview(ctx);
        expect(state.granted).toBe(false);
        expect(state.revokedAt).toBeInstanceOf(Date);
        expect(state.grantedBy).toEqual({ name: 'Admin revoke', email });

        const actions = (
            await prisma.auditLog.findMany({
                where: { tenantId: ctx.tenantId, action: { startsWith: 'CALENDAR_ADMIN_CONSENT_' } },
                orderBy: { createdAt: 'asc' },
                select: { action: true },
            })
        ).map((r: { action: string }) => r.action);
        expect(actions).toEqual(['CALENDAR_ADMIN_CONSENT_GRANTED', 'CALENDAR_ADMIN_CONSENT_REVOKED']);
    }, 30_000);

    it('a failed authorisation is one access row with the outcome and the bare codes, and records no grant', async () => {
        const { ctx } = await fixture('fail');
        await recordAdminConsentFailure(ctx, {
            provider: 'outlook-calendar',
            outcome: 'not_directory_admin',
            providerErrorCode: 'access_denied',
            aadstsCode: 'AADSTS90094',
        });

        const rows = await prisma.auditLog.findMany({
            where: { tenantId: ctx.tenantId, action: 'CALENDAR_ADMIN_CONSENT_FAILED' },
            select: { userId: true, entity: true, entityId: true, detailsJson: true, metadataJson: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ userId: ctx.userId, entity: 'Tenant', entityId: ctx.tenantId });
        expect(rows[0].detailsJson).toMatchObject({ category: 'access', operation: 'grant_failed', reason: 'not_directory_admin' });
        expect(rows[0].metadataJson).toMatchObject({
            provider: 'outlook-calendar',
            outcome: 'not_directory_admin',
            providerErrorCode: 'access_denied',
            aadstsCode: 'AADSTS90094',
        });

        expect((await getAdminConsentOverview(ctx))[0].granted).toBe(false);
    }, 30_000);
});
