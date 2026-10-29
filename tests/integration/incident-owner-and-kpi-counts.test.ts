/**
 * Incidents register (#4463), against a real database:
 *
 *   1. An incident's owner is stored only when they are an ACTIVE member of
 *      the incident's tenant — at create and at update. `Incident.ownerUserId`
 *      has no relation, so nothing below the usecase would refuse it.
 *   2. The register's KPI counts are counted over every incident in the
 *      tenant (and only that tenant), with the relation filter for a DUE or
 *      OVERDUE notification evaluated by Postgres, not by a mock.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    advancePhase,
    createIncident,
    getIncident,
    listIncidentKpiCounts,
    markReportable,
    updateIncident,
} from '@/app-layer/usecases/incident';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `inc-own-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;
const OTHER_TENANT_ID = `t2-${SUITE_TAG}`;

const userIds: string[] = [];
let ownerUserId: string;
let deactivatedUserId: string;
let otherTenantUserId: string;
let ctx: ReturnType<typeof makeRequestContext>;
let otherCtx: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, tenantId: string, role: Role, status: MembershipStatus) {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userIds.push(u.id);
    await globalPrisma.tenantMembership.create({ data: { tenantId, userId: u.id, role, status } });
    return u.id;
}

describeFn('incident owner membership + KPI counts (integration)', () => {
    beforeAll(async () => {
        for (const id of [TENANT_ID, OTHER_TENANT_ID]) {
            await globalPrisma.tenant.upsert({
                where: { id },
                update: {},
                create: { id, name: `t ${id}`, slug: id },
            });
        }
        ownerUserId = await makeUser('owner', TENANT_ID, Role.OWNER, MembershipStatus.ACTIVE);
        deactivatedUserId = await makeUser('gone', TENANT_ID, Role.EDITOR, MembershipStatus.DEACTIVATED);
        otherTenantUserId = await makeUser('other', OTHER_TENANT_ID, Role.OWNER, MembershipStatus.ACTIVE);
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: TENANT_ID, userId: ownerUserId });
        otherCtx = makeRequestContext('OWNER', {
            tenantId: OTHER_TENANT_ID,
            tenantSlug: OTHER_TENANT_ID,
            userId: otherTenantUserId,
        });
    });

    afterAll(async () => {
        const tenants = [TENANT_ID, OTHER_TENANT_ID];
        await globalPrisma.incident.deleteMany({ where: { tenantId: { in: tenants } } });
        await deleteAuditRowsForTenants(globalPrisma, tenants);
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(
                `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
                tenants,
            );
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
        await globalPrisma.tenant.deleteMany({ where: { id: { in: tenants } } });
        await globalPrisma.$disconnect();
    });

    const base = { severity: 'MEDIUM' as const, incidentType: 'OTHER' as const };

    it('refuses an owner from another tenant, or a deactivated member, at create', async () => {
        await expect(
            createIncident(ctx, { ...base, title: 'Foreign owner', ownerUserId: otherTenantUserId }),
        ).rejects.toThrow(/active member of this tenant/i);
        await expect(
            createIncident(ctx, { ...base, title: 'Departed owner', ownerUserId: deactivatedUserId }),
        ).rejects.toThrow(/active member of this tenant/i);
        await expect(
            createIncident(ctx, { ...base, title: 'Unknown owner', ownerUserId: 'no-such-user' }),
        ).rejects.toThrow(/active member of this tenant/i);
        const written = await globalPrisma.incident.count({
            where: { tenantId: TENANT_ID, title: { in: ['Foreign owner', 'Departed owner', 'Unknown owner'] } },
        });
        expect(written).toBe(0);
    });

    it('stores an active member, and refuses a foreign owner at update without changing the row', async () => {
        const inc = await createIncident(ctx, { ...base, title: 'Owned', ownerUserId });
        expect(inc.ownerUserId).toBe(ownerUserId);

        await expect(
            updateIncident(ctx, inc.id, { ownerUserId: otherTenantUserId }),
        ).rejects.toThrow(/active member of this tenant/i);
        expect((await getIncident(ctx, inc.id)).ownerUserId).toBe(ownerUserId);

        const cleared = await updateIncident(ctx, inc.id, { ownerUserId: null });
        expect(cleared?.ownerUserId).toBeNull();
    });

    it('counts the KPI cards over the whole tenant, and only that tenant', async () => {
        await globalPrisma.incident.deleteMany({ where: { tenantId: TENANT_ID } });

        // One open, one closed, one reportable with an overdue deadline.
        await createIncident(ctx, { ...base, title: 'Open' });
        const closed = await createIncident(ctx, { ...base, title: 'Closed' });
        await advancePhase(ctx, closed.id, { toPhase: 'CLOSED' });
        const reportable = await createIncident(ctx, {
            ...base,
            title: 'Reportable',
            detectedAt: new Date('2026-06-01T00:00:00.000Z').toISOString(),
        });
        await markReportable(ctx, reportable.id, { reportable: true });
        await globalPrisma.incidentNotification.updateMany({
            where: { tenantId: TENANT_ID, incidentId: reportable.id, kind: 'EARLY_WARNING_24H' },
            data: { status: 'OVERDUE' },
        });
        // Another tenant's incident never reaches these counts.
        await createIncident(otherCtx, { ...base, title: 'Elsewhere' });

        expect(await listIncidentKpiCounts(ctx)).toEqual({
            total: 3,
            open: 2,
            reportable: 1,
            deadlinesDueOrOverdue: 1,
        });
    });
});
