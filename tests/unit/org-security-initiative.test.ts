/**
 * Unit tests for org-security-initiative — no-DB pure helpers + permission
 * gates. DB-backed CRUD/link/rollup is covered by the ratchet + E2E. Also
 * satisfies usecase-test-coverage.
 */
import {
    deriveProgress,
    isInitiativeAtRisk,
    isInitiativeStale,
    createInitiative,
    changeInitiativeStatus,
    INITIATIVE_STATUSES,
} from '@/app-layer/usecases/org-security-initiative';
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
            canManageOwners: false,
            ...perms,
        },
    };
}

const DAY = 24 * 60 * 60 * 1000;

describe('org-security-initiative pure helpers', () => {
    it('deriveProgress: manual wins, else completed/total, no divide-by-zero', () => {
        expect(deriveProgress(60, 0, 5)).toEqual({ percent: 60, completed: 0, total: 5, manual: true });
        expect(deriveProgress(null, 2, 4)).toEqual({ percent: 50, completed: 2, total: 4, manual: false });
        expect(deriveProgress(null, 0, 0).percent).toBe(0);
    });

    it('isInitiativeAtRisk: BLOCKED or past-due (and not completed/cancelled)', () => {
        expect(isInitiativeAtRisk({ status: 'BLOCKED', targetDate: null })).toBe(true);
        expect(isInitiativeAtRisk({ status: 'IN_PROGRESS', targetDate: new Date(Date.now() - DAY) })).toBe(true);
        expect(isInitiativeAtRisk({ status: 'IN_PROGRESS', targetDate: new Date(Date.now() + DAY) })).toBe(false);
        expect(isInitiativeAtRisk({ status: 'COMPLETED', targetDate: new Date(Date.now() - DAY) })).toBe(false);
    });

    it('isInitiativeStale: IN_PROGRESS with no update in 30 days', () => {
        expect(isInitiativeStale({ status: 'IN_PROGRESS', updatedAt: new Date(Date.now() - 40 * DAY) })).toBe(true);
        expect(isInitiativeStale({ status: 'IN_PROGRESS', updatedAt: new Date() })).toBe(false);
        expect(isInitiativeStale({ status: 'PLANNED', updatedAt: new Date(Date.now() - 40 * DAY) })).toBe(false);
    });
});

describe('org-security-initiative permission gates (no DB)', () => {
    it('exports the status list', () => {
        expect(INITIATIVE_STATUSES).toEqual(['PLANNED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED']);
    });

    it('createInitiative requires canConfigureDashboard (forbidden before DB)', async () => {
        await expect(createInitiative(orgCtx({ canConfigureDashboard: false }), { title: 'x' })).rejects.toThrow();
    });

    it('rejects an invalid status before touching the DB', async () => {
        await expect(
            // @ts-expect-error — invalid status
            changeInitiativeStatus(orgCtx({}), 'id-1', 'NOPE'),
        ).rejects.toThrow(/Invalid initiative status/);
    });
});
