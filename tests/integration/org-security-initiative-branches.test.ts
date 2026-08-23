/**
 * Branch-coverage integration test for the org-security-initiative
 * usecases. The existing unit test only covers the pure helpers + the
 * permission gates; the DB-backed CRUD / status / link / widget paths
 * were "covered by E2E" (which doesn't count toward jest coverage). This
 * exercises them against a real DB.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import type { OrgContext } from '@/app-layer/types';
import type { OrgPermissionSet } from '@/lib/permissions';
import {
    listInitiatives,
    getInitiative,
    createInitiative,
    updateInitiative,
    changeInitiativeStatus,
    deleteInitiative,
    linkWork,
    unlinkWork,
    getInitiativesForWidget,
} from '@/app-layer/usecases/org-security-initiative';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `osi-${randomUUID().slice(0, 8)}`;
const ORG_ID = `org-${TAG}`;
const TENANT_ID = `t-${TAG}`;
let ownerUserId: string;
let controlId: string;

const FULL_PERMS: OrgPermissionSet = {
    canViewPortfolio: true, canDrillDown: true, canExportReports: true,
    canManageTenants: true, canManageMembers: true, canConfigureDashboard: true,
    canSetThreatLevel: true, canSetMaturity: true,
};
function orgCtx(perms: Partial<OrgPermissionSet> = {}): OrgContext {
    return {
        requestId: 'req-test', userId: ownerUserId, organizationId: ORG_ID,
        orgSlug: TAG, orgRole: 'ORG_ADMIN',
        permissions: { ...FULL_PERMS, ...perms },
    };
}

describeFn('org-security-initiative usecase — branch coverage (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.organization.upsert({
            where: { id: ORG_ID }, update: {},
            create: { id: ORG_ID, name: `Org ${TAG}`, slug: TAG },
        });
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID }, update: { organizationId: ORG_ID },
            create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG, organizationId: ORG_ID },
        });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        ownerUserId = u.id;
        await globalPrisma.tenantMembership.create({
            data: { tenantId: TENANT_ID, userId: ownerUserId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        const control = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'C-1', name: 'Linked control', status: 'IMPLEMENTED' },
        });
        controlId = control.id;
    });

    afterAll(async () => {
        await globalPrisma.orgInitiativeLink.deleteMany({ where: { organizationId: ORG_ID } });
        await globalPrisma.orgSecurityInitiative.deleteMany({ where: { organizationId: ORG_ID } });
        await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "OrgAuditLog" WHERE "organizationId" = $1`, ORG_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        // Guarded: an undefined filter value is DROPPED, not matched —
        // see the teardown note in ./db-helper.ts.
        if (ownerUserId) {
            await globalPrisma.user.deleteMany({ where: { id: ownerUserId } });
        }
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.organization.deleteMany({ where: { id: ORG_ID } });
        await globalPrisma.$disconnect();
    });

    it('createInitiative: success + empty-title rejection + permission gate', async () => {
        const ctx = orgCtx();
        const created = await createInitiative(ctx, {
            title: 'Roll out MFA', description: 'org-wide', ownerUserId, targetDate: '2026-09-01T00:00:00Z',
        });
        expect(created.title).toBe('Roll out MFA');
        // description-null branch + no target.
        const c2 = await createInitiative(ctx, { title: 'Second' });
        expect(c2.description).toBeNull();
        await expect(createInitiative(ctx, { title: '   ' })).rejects.toThrow(/title is required/i);
        await expect(createInitiative(orgCtx({ canConfigureDashboard: false }), { title: 'x' }))
            .rejects.toThrow(/admin/i);
    });

    it('list / get: filters, not-found, read permission gate', async () => {
        const ctx = orgCtx();
        expect((await listInitiatives(ctx)).length).toBeGreaterThanOrEqual(2);
        expect(Array.isArray(await listInitiatives(ctx, { status: 'PLANNED', take: 10 }))).toBe(true);
        await expect(getInitiative(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(listInitiatives(orgCtx({ canViewPortfolio: false }))).rejects.toThrow(/access/i);
    });

    it('updateInitiative: every field three-state + progress clamping', async () => {
        const ctx = orgCtx();
        const init = await createInitiative(ctx, { title: 'Update me' });
        const u = await updateInitiative(ctx, init.id, {
            title: 'Updated', description: 'desc', ownerUserId, targetDate: '2026-10-01T00:00:00Z',
            manualProgressPercent: 150, // clamps to 100
        });
        expect(u.title).toBe('Updated');
        expect(u.manualProgressPercent).toBe(100);
        const u2 = await updateInitiative(ctx, init.id, {
            description: null, targetDate: null, manualProgressPercent: -10, // clamps to 0
        });
        expect(u2.description).toBeNull();
        expect(u2.manualProgressPercent).toBe(0);
        const u3 = await updateInitiative(ctx, init.id, { manualProgressPercent: null });
        expect(u3.manualProgressPercent).toBeNull();
    });

    it('changeInitiativeStatus: invalid, IN_PROGRESS (startedAt), COMPLETED (completedAt)', async () => {
        const ctx = orgCtx();
        const init = await createInitiative(ctx, { title: 'Lifecycle' });
        await expect(changeInitiativeStatus(ctx, init.id, 'NONSENSE' as never)).rejects.toThrow(/invalid/i);
        const ip = await changeInitiativeStatus(ctx, init.id, 'IN_PROGRESS');
        expect(ip.startedAt).not.toBeNull();
        const done = await changeInitiativeStatus(ctx, init.id, 'COMPLETED');
        expect(done.completedAt).not.toBeNull();
    });

    it('linkWork / unlinkWork: invalid type, foreign tenant, success + idempotent', async () => {
        const ctx = orgCtx();
        const init = await createInitiative(ctx, { title: 'Linked' });
        await expect(linkWork(ctx, init.id, { tenantId: TENANT_ID, entityType: 'BOGUS', entityId: controlId }))
            .rejects.toThrow(/invalid link/i);
        await expect(linkWork(ctx, init.id, { tenantId: 'foreign-tenant', entityType: 'CONTROL', entityId: controlId }))
            .rejects.toThrow(/belong to a tenant/i);
        const link = await linkWork(ctx, init.id, { tenantId: TENANT_ID, entityType: 'CONTROL', entityId: controlId });
        expect(link.id).toBeTruthy();
        // idempotent upsert.
        const again = await linkWork(ctx, init.id, { tenantId: TENANT_ID, entityType: 'CONTROL', entityId: controlId });
        expect(again.id).toBe(link.id);
        await unlinkWork(ctx, link.id);
    });

    it('getInitiativesForWidget: default + statusFilter, progress (manual + linked), atRisk', async () => {
        const ctx = orgCtx();
        // an at-risk BLOCKED initiative + a manual-progress one + a linked one.
        const blocked = await createInitiative(ctx, { title: 'Blocked one' });
        await changeInitiativeStatus(ctx, blocked.id, 'BLOCKED');
        const manual = await createInitiative(ctx, { title: 'Manual progress' });
        await updateInitiative(ctx, manual.id, { manualProgressPercent: 40 });
        const linked = await createInitiative(ctx, { title: 'Has link' });
        await linkWork(ctx, linked.id, { tenantId: TENANT_ID, entityType: 'CONTROL', entityId: controlId });

        const w = await getInitiativesForWidget(ctx);
        expect(w.inFlight).toBeGreaterThanOrEqual(1);
        expect(w.rows.length).toBeGreaterThanOrEqual(1);
        const w2 = await getInitiativesForWidget(ctx, { topN: 50, statusFilter: ['BLOCKED'] });
        expect(w2.atRisk).toBeGreaterThanOrEqual(1);
    });

    it('deleteInitiative removes the row', async () => {
        const ctx = orgCtx();
        const init = await createInitiative(ctx, { title: 'To delete' });
        await deleteInitiative(ctx, init.id);
        await expect(getInitiative(ctx, init.id)).rejects.toThrow(/not found/i);
    });
});
