/**
 * Branch-coverage integration test for the org-maturity + org-threat-level
 * usecases. Their unit tests cover only pure helpers; the DB-backed
 * get/set/trend/history paths were E2E-only (uncounted). Exercised here
 * against a real DB.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import type { OrgContext } from '@/app-layer/types';
import type { OrgPermissionSet } from '@/lib/permissions';
import {
    getCurrentOrgMaturity,
    setOrgMaturityRating,
    getOrgMaturityTrend,
} from '@/app-layer/usecases/org-maturity';
import {
    getCurrentOrgThreatLevel,
    setOrgThreatLevel,
    getOrgThreatLevelHistory,
} from '@/app-layer/usecases/org-threat-level';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `omt-${randomUUID().slice(0, 8)}`;
const ORG_ID = `org-${TAG}`;
let userId: string;

const FULL: OrgPermissionSet = {
    canViewPortfolio: true, canDrillDown: true, canExportReports: true,
    canManageTenants: true, canManageMembers: true, canConfigureDashboard: true,
    canSetThreatLevel: true, canSetMaturity: true,
};
function orgCtx(perms: Partial<OrgPermissionSet> = {}): OrgContext {
    return {
        requestId: 'req-test', userId, organizationId: ORG_ID, orgSlug: TAG,
        orgRole: 'ORG_ADMIN', permissions: { ...FULL, ...perms },
    };
}

describeFn('org-maturity + org-threat-level — branch coverage (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.organization.upsert({
            where: { id: ORG_ID }, update: {}, create: { id: ORG_ID, name: `Org ${TAG}`, slug: TAG },
        });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        userId = u.id;
    });

    afterAll(async () => {
        await globalPrisma.orgMaturityRating.deleteMany({ where: { organizationId: ORG_ID } });
        await globalPrisma.orgThreatLevel.deleteMany({ where: { organizationId: ORG_ID } });
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "OrgAuditLog" WHERE "organizationId" = $1`, ORG_ID);
        });
        // Guarded: an undefined filter value is DROPPED, not matched —
        // see the teardown note in ./db-helper.ts.
        if (userId) {
            await globalPrisma.user.deleteMany({ where: { id: userId } });
        }
        await globalPrisma.organization.deleteMany({ where: { id: ORG_ID } });
        await globalPrisma.$disconnect();
    });

    it('org-maturity: default (no ratings), set (valid + invalid domain/level), trend, perm gates', async () => {
        const ctx = orgCtx();
        // default — no ratings yet.
        const d0 = await getCurrentOrgMaturity(ctx);
        expect(d0).toBeTruthy();
        // invalid domain + invalid level branches.
        await expect(setOrgMaturityRating(ctx, { domain: 'BOGUS' as never, level: 'DEFINED' as never }))
            .rejects.toThrow(/invalid maturity domain/i);
        await expect(setOrgMaturityRating(ctx, { domain: 'GOVERN', level: 'BOGUS' as never }))
            .rejects.toThrow(/invalid maturity level/i);
        // valid set, with rationale.
        await setOrgMaturityRating(ctx, { domain: 'GOVERN', level: 'DEFINED', rationale: 'policies in place' });
        await setOrgMaturityRating(ctx, { domain: 'PROTECT', level: 'MANAGED' });
        const d1 = await getCurrentOrgMaturity(ctx);
        expect(d1).toBeTruthy();
        // trend (clamps months).
        expect(Array.isArray(await getOrgMaturityTrend(ctx, 0))).toBe(true);
        expect(Array.isArray(await getOrgMaturityTrend(ctx))).toBe(true);
        // permission gates.
        await expect(getCurrentOrgMaturity(orgCtx({ canViewPortfolio: false }))).rejects.toThrow(/access/i);
        await expect(setOrgMaturityRating(orgCtx({ canSetMaturity: false }), { domain: 'GOVERN', level: 'DEFINED' }))
            .rejects.toThrow(/admin/i);
    });

    it('org-threat-level: default GUARDED, set (valid + invalid + empty summary), history, perm gates', async () => {
        const ctx = orgCtx();
        const d0 = await getCurrentOrgThreatLevel(ctx);
        expect(d0.level).toBe('GUARDED'); // default when none set.
        await expect(setOrgThreatLevel(ctx, { level: 'BOGUS' as never, summary: 'x' }))
            .rejects.toThrow(/invalid threat level/i);
        await expect(setOrgThreatLevel(ctx, { level: 'ELEVATED', summary: '   ' }))
            .rejects.toThrow(/summary is required/i);
        await setOrgThreatLevel(ctx, { level: 'ELEVATED', summary: 'Active phishing campaign', detail: 'details' });
        const d1 = await getCurrentOrgThreatLevel(ctx);
        expect(d1.level).toBe('ELEVATED');
        expect((await getOrgThreatLevelHistory(ctx, 10)).length).toBeGreaterThanOrEqual(1);
        // permission gates.
        await expect(getCurrentOrgThreatLevel(orgCtx({ canViewPortfolio: false }))).rejects.toThrow(/access/i);
        await expect(setOrgThreatLevel(orgCtx({ canSetThreatLevel: false }), { level: 'LOW', summary: 'x' }))
            .rejects.toThrow(/admin/i);
    });
});
