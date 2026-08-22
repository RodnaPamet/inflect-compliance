/**
 * Unit tests for the org-maturity usecases — no-DB permission +
 * validation paths + the pure coverage→band helper. DB-backed
 * round-trips are covered by the ratchet + manual verification. Also
 * satisfies the usecase-test-coverage guardrail.
 */
import {
    setOrgMaturityRating,
    getCurrentOrgMaturity,
    getOrgMaturityTrend,
    coverageToMaturityBand,
    MATURITY_DOMAINS,
    MATURITY_LEVELS,
} from '@/app-layer/usecases/org-maturity';
import type { OrgContext } from '@/app-layer/types';
import type { OrgPermissionSet } from '@/lib/permissions';

function orgCtx(perms: Partial<OrgPermissionSet>): OrgContext {
    return {
        requestId: 'req-test',
        userId: 'user-1',
        organizationId: 'org-1',
        orgSlug: 'acme',
        orgRole: 'ORG_ADMIN',
        permissions: {
            canViewPortfolio: true,
            canDrillDown: true,
            canExportReports: true,
            canManageTenants: true,
            canManageMembers: true,
            canConfigureDashboard: true,
            canSetThreatLevel: true,
            canSetMaturity: true,
            ...perms,
        },
    };
}

describe('org-maturity usecases', () => {
    it('exports the usecases + domain/level lists', () => {
        expect(typeof setOrgMaturityRating).toBe('function');
        expect(typeof getCurrentOrgMaturity).toBe('function');
        expect(typeof getOrgMaturityTrend).toBe('function');
        expect(MATURITY_DOMAINS).toEqual(['GOVERN', 'IDENTIFY', 'PROTECT', 'DETECT', 'RESPOND', 'RECOVER']);
        // LITERAL ON PURPOSE — do not derive. CMM has five maturity levels and
        // MATURITY_LEVEL_NUM maps them onto 1..5; a sixth level would silently
        // break every band comparison, so it must fail here first.
        expect(MATURITY_LEVELS).toHaveLength(5);
    });

    it('coverageToMaturityBand maps coverage % to a CMM band (advisory)', () => {
        expect(coverageToMaturityBand(95)).toEqual({ level: 'OPTIMIZING', num: 5 });
        expect(coverageToMaturityBand(80)).toEqual({ level: 'MANAGED', num: 4 });
        expect(coverageToMaturityBand(65)).toEqual({ level: 'DEFINED', num: 3 });
        expect(coverageToMaturityBand(45)).toEqual({ level: 'REPEATABLE', num: 2 });
        expect(coverageToMaturityBand(10)).toEqual({ level: 'INITIAL', num: 1 });
    });

    it('setOrgMaturityRating requires canSetMaturity (forbidden before DB)', async () => {
        await expect(
            setOrgMaturityRating(orgCtx({ canSetMaturity: false }), { domain: 'GOVERN', level: 'DEFINED' }),
        ).rejects.toThrow();
    });

    it('rejects an invalid domain/level before touching the DB', async () => {
        await expect(
            // @ts-expect-error — invalid domain
            setOrgMaturityRating(orgCtx({}), { domain: 'NOPE', level: 'DEFINED' }),
        ).rejects.toThrow(/Invalid maturity domain/);
        await expect(
            // @ts-expect-error — invalid level
            setOrgMaturityRating(orgCtx({}), { domain: 'GOVERN', level: 'NOPE' }),
        ).rejects.toThrow(/Invalid maturity level/);
    });

    it('read paths require canViewPortfolio', async () => {
        const ctx = orgCtx({ canViewPortfolio: false });
        await expect(getCurrentOrgMaturity(ctx)).rejects.toThrow();
        await expect(getOrgMaturityTrend(ctx)).rejects.toThrow();
    });
});
