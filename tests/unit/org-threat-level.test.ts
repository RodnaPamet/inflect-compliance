/**
 * Unit tests for the org-threat-level usecases — the no-DB permission +
 * validation paths. The DB-backed get/set/history round-trips are covered
 * by the structural ratchet + manual verification. Also satisfies the
 * usecase-test-coverage guardrail (every usecase file must be imported).
 */
import {
    setOrgThreatLevel,
    getCurrentOrgThreatLevel,
    getOrgThreatLevelHistory,
    ORG_THREAT_TIERS,
} from '@/app-layer/usecases/org-threat-level';
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
            canManageAgentSwitches: true,
            ...perms,
        },
    };
}

describe('org-threat-level usecases', () => {
    it('exports the usecases + the tier list', () => {
        expect(typeof setOrgThreatLevel).toBe('function');
        expect(typeof getCurrentOrgThreatLevel).toBe('function');
        expect(typeof getOrgThreatLevelHistory).toBe('function');
        expect(ORG_THREAT_TIERS).toEqual(['GUARDED', 'LOW', 'ELEVATED', 'HIGH', 'SEVERE']);
    });

    it('setOrgThreatLevel requires canSetThreatLevel (forbidden before DB)', async () => {
        const ctx = orgCtx({ canSetThreatLevel: false });
        await expect(
            setOrgThreatLevel(ctx, { level: 'HIGH', summary: 'x' }),
        ).rejects.toThrow();
    });

    it('rejects an invalid tier before touching the DB', async () => {
        const ctx = orgCtx({});
        await expect(
            // @ts-expect-error — deliberately invalid tier
            setOrgThreatLevel(ctx, { level: 'BOGUS', summary: 'x' }),
        ).rejects.toThrow(/Invalid threat level/);
    });

    it('rejects an empty summary before touching the DB', async () => {
        const ctx = orgCtx({});
        await expect(
            setOrgThreatLevel(ctx, { level: 'HIGH', summary: '   ' }),
        ).rejects.toThrow(/summary is required/);
    });

    it('read paths require canViewPortfolio', async () => {
        const ctx = orgCtx({ canViewPortfolio: false });
        await expect(getCurrentOrgThreatLevel(ctx)).rejects.toThrow();
        await expect(getOrgThreatLevelHistory(ctx)).rejects.toThrow();
    });
});
