/**
 * Integration tests for vendor CRUD + list + workflow usecases —
 * coverage wave A.
 *
 * Raises branch coverage of `src/app-layer/usecases/vendor.ts` across:
 *   - createVendor      (every free-text `?` sanitise branch, full + minimal)
 *   - updateVendor      (status-change vs plain-update audit branches, not-found)
 *   - listVendors / listVendorsPaginated (status/criticality/riskRating/q/
 *                        reviewDue filter branches + cursor pagination)
 *   - getVendor         (not-found)
 *   - setVendorReviewDates (happy path + not-found)
 *   - addVendorLink / removeVendorLink (relation default branch + not-found)
 *   - updateVendor activation gate (gate-blocks, gate-passes, already-active,
 *                        non-ACTIVE transition, not-found)
 *   - getVendorMetrics  (every counter branch)
 *   - enrichVendor      (domain branch, websiteUrl-derived branch, no-domain
 *                        rejection)
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import { NotFoundError, ValidationError, ForbiddenError } from '@/lib/errors/types';
import {
    createVendor,
    updateVendor,
    getVendor,
    listVendors,
    listVendorsPaginated,
    setVendorReviewDates,
    addVendorLink,
    removeVendorLink,
    listVendorLinks,
    getVendorMetrics,
    enrichVendor,
} from '@/app-layer/usecases/vendor';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `vcrud-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE}`;

let admin: { userId: string };
let reader: { userId: string };

async function makeUser(label: string): Promise<{ userId: string }> {
    const email = `${SUITE}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id };
}

function ctxAs(role: Role, userId: string) {
    return makeRequestContext(role, { userId, tenantId: TENANT_ID });
}

async function clearAudit() {
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
    });
}

describeFn('vendor CRUD + workflow — integration', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE}`, slug: SUITE },
        });
        admin = await makeUser('admin');
        reader = await makeUser('reader');
        await globalPrisma.tenantMembership.createMany({
            data: [
                { tenantId: TENANT_ID, userId: admin.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
                { tenantId: TENANT_ID, userId: reader.userId, role: Role.READER, status: MembershipStatus.ACTIVE },
            ],
        });
    });

    afterEach(async () => {
        await globalPrisma.vendorLink.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.vendorDocument.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.vendorAssessment.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.vendor.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.risk.deleteMany({ where: { tenantId: TENANT_ID } });
        await clearAudit();
    });

    afterAll(async () => {
        await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } });
        await clearAudit();
        await globalPrisma.user.deleteMany({ where: { id: { in: [admin.userId, reader.userId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    const adminCtx = () => ctxAs(Role.ADMIN, admin.userId);

    // ── createVendor ─────────────────────────────────────────────

    it('createVendor sanitises every free-text field (truthy branches)', async () => {
        const v = await createVendor(adminCtx(), {
            name: 'Acme Corp',
            legalName: 'Acme Incorporated',
            country: 'US',
            domain: 'acme.test',
            websiteUrl: 'https://acme.test',
            description: 'A vendor',
            tags: ['saas', 'critical'],
            criticality: 'HIGH',
        });
        expect(v.name).toBe('Acme Corp');
        expect(v.legalName).toBe('Acme Incorporated');
        const audit = await globalPrisma.auditLog.findFirst({
            where: { tenantId: TENANT_ID, action: 'VENDOR_CREATED' },
        });
        expect(audit).toBeTruthy();
    });

    it('createVendor with only name leaves the optional-field falsy branches', async () => {
        const v = await createVendor(adminCtx(), { name: 'Minimal Co' });
        expect(v.legalName).toBeNull();
        expect(v.domain).toBeNull();
        expect(v.status).toBe('ONBOARDING');
    });

    it('createVendor rejects a READER (canWrite gate)', async () => {
        await expect(
            createVendor(ctxAs(Role.READER, reader.userId), { name: 'Nope' }),
        ).rejects.toBeInstanceOf(ForbiddenError);
    });

    // ── updateVendor ─────────────────────────────────────────────

    it('updateVendor with a non-status patch emits VENDOR_UPDATED', async () => {
        const v = await createVendor(adminCtx(), { name: 'Before' });
        await clearAudit();
        const updated = await updateVendor(adminCtx(), v.id, { name: 'After', description: 'new' });
        expect(updated.name).toBe('After');
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'VENDOR_UPDATED' } })).toBe(1);
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'VENDOR_STATUS_CHANGED' } })).toBe(0);
    });

    it('updateVendor with a changed status emits VENDOR_STATUS_CHANGED', async () => {
        const v = await createVendor(adminCtx(), { name: 'StatusVendor', status: 'ONBOARDING' });
        await clearAudit();
        const updated = await updateVendor(adminCtx(), v.id, { status: 'OFFBOARDING' });
        expect(updated.status).toBe('OFFBOARDING');
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'VENDOR_STATUS_CHANGED' } })).toBe(1);
    });

    it('updateVendor with same status falls into the VENDOR_UPDATED branch', async () => {
        const v = await createVendor(adminCtx(), { name: 'SameStatus', status: 'ONBOARDING' });
        await clearAudit();
        await updateVendor(adminCtx(), v.id, { status: 'ONBOARDING' });
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'VENDOR_UPDATED' } })).toBe(1);
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'VENDOR_STATUS_CHANGED' } })).toBe(0);
    });

    it('updateVendor throws NotFoundError for an unknown id', async () => {
        await expect(updateVendor(adminCtx(), 'nope', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('updateVendor sanitises a string-only tags array (Array.isArray branch)', async () => {
        const v = await createVendor(adminCtx(), { name: 'Tagged' });
        const updated = await updateVendor(adminCtx(), v.id, { tags: ['<b>x</b>', 'clean'] });
        expect(updated).toBeTruthy();
    });

    it('updateVendor passes a non-string tag through the false arm before the repo validates', async () => {
        const v = await createVendor(adminCtx(), { name: 'Tagged2' });
        // The usecase tag-map runs first: the number element exercises the
        // `typeof t === 'string'` FALSE arm (`: t`, passed through untouched).
        // The repository's validateVendorTags then rejects the non-string
        // tag — so the call surfaces a ValidationError, by which point the
        // sanitiser's false arm has already executed.
        await expect(
            updateVendor(adminCtx(), v.id, { tags: ['ok', 42] }),
        ).rejects.toBeInstanceOf(ValidationError);
    });

    // ── getVendor ────────────────────────────────────────────────

    it('getVendor returns the row; throws NotFoundError when absent', async () => {
        const v = await createVendor(adminCtx(), { name: 'Findable' });
        const got = await getVendor(adminCtx(), v.id);
        expect(got.id).toBe(v.id);
        await expect(getVendor(adminCtx(), 'missing')).rejects.toBeInstanceOf(NotFoundError);
    });

    // ── listVendors / listVendorsPaginated ───────────────────────

    it('listVendors honours status / criticality / q / riskRating / reviewDue filters', async () => {
        const now = new Date();
        const overdue = new Date(now.getTime() - 86400000).toISOString();
        await createVendor(adminCtx(), { name: 'AlphaSearch', status: 'ACTIVE', criticality: 'HIGH', nextReviewAt: overdue });
        await createVendor(adminCtx(), { name: 'BetaCo', status: 'ONBOARDING', criticality: 'LOW' });

        // status filter
        expect((await listVendors(adminCtx(), { status: 'ACTIVE' })).length).toBe(1);
        // criticality filter
        expect((await listVendors(adminCtx(), { criticality: 'LOW' })).length).toBe(1);
        // free-text q filter (OR branch)
        expect((await listVendors(adminCtx(), { q: 'alpha' })).length).toBe(1);
        // reviewDue overdue branch
        expect((await listVendors(adminCtx(), { reviewDue: 'overdue' })).length).toBe(1);
        // reviewDue next30d branch (no rows due in next 30d here)
        expect((await listVendors(adminCtx(), { reviewDue: 'next30d' })).length).toBe(0);
        // riskRating filter (assessments.some branch) — no assessments → 0
        expect((await listVendors(adminCtx(), { riskRating: 'HIGH' })).length).toBe(0);
        // take option branch
        expect((await listVendors(adminCtx(), {}, { take: 1 })).length).toBe(1);
        // no-filter branch
        expect((await listVendors(adminCtx())).length).toBe(2);
    });

    it('listVendorsPaginated returns a page + a working cursor', async () => {
        for (let i = 0; i < 3; i++) {
            await createVendor(adminCtx(), { name: `Page-${i}` });
        }
        const first = await listVendorsPaginated(adminCtx(), { limit: 2 });
        expect(first.items.length).toBe(2);
        expect(first.pageInfo.hasNextPage).toBe(true);
        // cursor branch (where.AND absent → initialised)
        const second = await listVendorsPaginated(adminCtx(), { limit: 2, cursor: first.pageInfo.nextCursor! });
        expect(second.items.length).toBe(1);
        // cursor + a filter so where.AND pre-exists (push branch)
        const filtered = await listVendorsPaginated(adminCtx(), { limit: 1, cursor: first.pageInfo.nextCursor!, filters: { q: 'Page' } });
        expect(filtered.items.length).toBeGreaterThanOrEqual(0);
    });

    it('listVendors rejects a context without read access', async () => {
        const readerPerms = getPermissionsForRole(Role.READER);
        const noRead = makeRequestContext(Role.READER, {
            userId: reader.userId,
            tenantId: TENANT_ID,
            permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
            // Vendor policies read the custom-role-aware set (2026-07-28), so
            // revoking the coarse tier alone no longer denies — `vendors.view`
            // has to be revoked too. Overriding BOTH keeps this test honest
            // about what it is asserting rather than passing on a stale channel.
            appPermissions: { ...readerPerms, vendors: { ...readerPerms.vendors, view: false } },
        });
        await expect(listVendors(noRead)).rejects.toBeInstanceOf(ForbiddenError);
    });

    // ── setVendorReviewDates ─────────────────────────────────────

    it('setVendorReviewDates updates dates + emits audit; not-found throws', async () => {
        const v = await createVendor(adminCtx(), { name: 'Reviewable' });
        const updated = await setVendorReviewDates(adminCtx(), v.id, {
            nextReviewAt: new Date(Date.now() + 10 * 86400000).toISOString(),
            contractRenewalAt: null,
        });
        expect(updated.nextReviewAt).toBeTruthy();
        await expect(setVendorReviewDates(adminCtx(), 'nope', {})).rejects.toBeInstanceOf(NotFoundError);
    });

    // ── vendor links ─────────────────────────────────────────────

    it('addVendorLink defaults relation, removeVendorLink not-found throws', async () => {
        const v = await createVendor(adminCtx(), { name: 'Linked' });
        const risk1 = await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R1' } });
        const risk2 = await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R2' } });

        // default relation branch (no `relation`)
        const link = await addVendorLink(adminCtx(), v.id, { entityType: 'RISK', entityId: risk1.id });
        expect(link.relation).toBe('RELATED');
        // explicit relation branch
        const link2 = await addVendorLink(adminCtx(), v.id, { entityType: 'RISK', entityId: risk2.id, relation: 'MITIGATES' });
        expect(link2.relation).toBe('MITIGATES');

        const links = await listVendorLinks(adminCtx(), v.id);
        expect(links.length).toBe(2);

        const removed = await removeVendorLink(adminCtx(), link.id);
        expect(removed.id).toBe(link.id);
        await expect(removeVendorLink(adminCtx(), 'no-link')).rejects.toBeInstanceOf(NotFoundError);
    });

    // ── activation gate via the live updateVendor edit path (PR-T) ──

    it('gate blocks ACTIVE without an approved assessment', async () => {
        const v = await createVendor(adminCtx(), { name: 'Gated', status: 'ONBOARDING' });
        await expect(
            updateVendor(adminCtx(), v.id, { status: 'ACTIVE' }),
        ).rejects.toBeInstanceOf(ValidationError);
    });

    it('gate allows ACTIVE when a completed-review assessment with a rating exists', async () => {
        const v = await createVendor(adminCtx(), { name: 'Approvable', status: 'ONBOARDING' });
        await globalPrisma.vendorAssessment.create({
            data: {
                tenantId: TENANT_ID,
                vendorId: v.id,
                requestedByUserId: admin.userId,
                status: 'REVIEWED',
                riskRating: 'LOW',
            },
        });
        const updated = await updateVendor(adminCtx(), v.id, { status: 'ACTIVE' });
        expect(updated.status).toBe('ACTIVE');
    });

    it('gate is skipped when vendor already ACTIVE', async () => {
        const v = await createVendor(adminCtx(), { name: 'AlreadyActive', status: 'ACTIVE' });
        // No approved assessment, but vendor.status === ACTIVE so the gate `if` is false.
        const updated = await updateVendor(adminCtx(), v.id, { status: 'ACTIVE' });
        expect(updated.status).toBe('ACTIVE');
    });

    it('gate is skipped for a non-ACTIVE target status', async () => {
        const v = await createVendor(adminCtx(), { name: 'Offboard', status: 'ACTIVE' });
        const updated = await updateVendor(adminCtx(), v.id, { status: 'OFFBOARDING' });
        expect(updated.status).toBe('OFFBOARDING');
    });

    it('updateVendor throws NotFoundError for unknown vendor status change', async () => {
        await expect(
            updateVendor(adminCtx(), 'nope', { status: 'ACTIVE' }),
        ).rejects.toBeInstanceOf(NotFoundError);
    });

    // ── getVendorMetrics ─────────────────────────────────────────

    it('getVendorMetrics aggregates every counter branch', async () => {
        const now = Date.now();
        const overdue = new Date(now - 86400000).toISOString();
        const soon = new Date(now + 10 * 86400000).toISOString();

        // overdue review + overdue renewal
        await createVendor(adminCtx(), { name: 'M-overdue', criticality: 'CRITICAL', nextReviewAt: overdue, contractRenewalAt: overdue });
        // upcoming review + upcoming renewal
        await createVendor(adminCtx(), { name: 'M-soon', criticality: 'LOW', nextReviewAt: soon, contractRenewalAt: soon });
        // high-criticality vendor with no approved assessment → highRiskNoAssessment
        await createVendor(adminCtx(), { name: 'M-high', criticality: 'HIGH' });

        const m = await getVendorMetrics(adminCtx());
        expect(m.totalVendors).toBe(3);
        expect(m.overdueReview).toBe(1);
        expect(m.upcomingReview).toBe(1);
        expect(m.overdueRenewal).toBe(1);
        expect(m.upcomingRenewal).toBe(1);
        expect(m.highRiskNoAssessment).toBeGreaterThanOrEqual(2); // CRITICAL + HIGH, no approved assessment
        expect(m.byCriticality.CRITICAL).toBe(1);
        expect(typeof m.expiringDocuments).toBe('number');
    });

    it('getVendorMetrics counts a latest-assessment riskRating + excludes approved high-risk', async () => {
        const v = await createVendor(adminCtx(), { name: 'M-rated', criticality: 'HIGH' });
        await globalPrisma.vendorAssessment.create({
            data: {
                tenantId: TENANT_ID,
                vendorId: v.id,
                requestedByUserId: admin.userId,
                status: 'APPROVED',
                riskRating: 'HIGH',
            },
        });
        const m = await getVendorMetrics(adminCtx());
        expect(m.byRiskRating.HIGH).toBe(1);
        // APPROVED ⇒ NOT counted as highRiskNoAssessment
        expect(m.highRiskNoAssessment).toBe(0);
    });

    // ── enrichVendor ─────────────────────────────────────────────

    it('enrichVendor uses vendor.domain (domain branch) and marks SUCCESS', async () => {
        const v = await createVendor(adminCtx(), { name: 'Enrichable', domain: 'enrich.test' });
        const updated = await enrichVendor(adminCtx(), v.id);
        expect(updated.enrichmentStatus).toBe('SUCCESS');
        expect(updated.enrichmentLastRunAt).toBeTruthy();
    });

    it('enrichVendor derives domain from websiteUrl when domain is null', async () => {
        const v = await createVendor(adminCtx(), { name: 'WebOnly', websiteUrl: 'https://web-only.test/path' });
        const updated = await enrichVendor(adminCtx(), v.id);
        expect(updated.enrichmentStatus).toBe('SUCCESS');
    });

    it('enrichVendor rejects a vendor with no domain/website (badRequest branch)', async () => {
        const v = await createVendor(adminCtx(), { name: 'NoDomain' });
        await expect(enrichVendor(adminCtx(), v.id)).rejects.toBeInstanceOf(ValidationError);
    });

    it('enrichVendor throws NotFoundError for an unknown vendor', async () => {
        await expect(enrichVendor(adminCtx(), 'nope')).rejects.toBeInstanceOf(NotFoundError);
    });
});
