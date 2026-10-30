/**
 * Epic O-2 — `getOrgPermissions` unit contract.
 *
 * Locks the role-to-permission mapping that the org dashboard UI and
 * the org-scoped API routes will rely on. Any change to the mapping
 * must update this test in the same diff — the explicit per-role
 * assertion makes a "looser ORG_READER" PR review-visible.
 */
import { getOrgPermissions, type OrgPermissionSet } from '@/lib/permissions';

describe('Epic O-2 — getOrgPermissions', () => {
    it('ORG_OWNER is granted every capability, the owner-only ones included (#4576)', () => {
        const p = getOrgPermissions('ORG_OWNER');
        expect(p).toEqual<OrgPermissionSet>({
            canViewPortfolio: true,
            canDrillDown: true,
            canExportReports: true,
            canManageTenants: true,
            canManageMembers: true,
            canConfigureDashboard: true,
            canSetThreatLevel: true,
            canSetMaturity: true,
            canManageAgentSwitches: true,
            canManageOwners: true,
        });
    });

    it('ORG_ADMIN is granted every capability but the owner-only ones', () => {
        const p = getOrgPermissions('ORG_ADMIN');
        expect(p).toEqual<OrgPermissionSet>({
            canViewPortfolio: true,
            canDrillDown: true,
            canExportReports: true,
            // Owner-only since #4576 (owner decision, 2026-10-30).
            canManageTenants: false,
            canManageMembers: true,
            canConfigureDashboard: true,
            canSetThreatLevel: true,
            canSetMaturity: true,
            canManageAgentSwitches: true,
            canManageOwners: false,
        });
    });

    it('ORG_READER sees the portfolio summary + can export, nothing else', () => {
        const p = getOrgPermissions('ORG_READER');
        expect(p).toEqual<OrgPermissionSet>({
            canViewPortfolio: true,
            canDrillDown: false, // no auto-provisioned ADMIN membership
            canExportReports: true,
            canManageTenants: false,
            canManageMembers: false,
            canConfigureDashboard: false,
            canSetThreatLevel: false,
            canSetMaturity: false,
            canManageAgentSwitches: false,
            canManageOwners: false,
        });
    });

    it('ORG_READER cannot drill down (mirrors the absence of ADMIN membership)', () => {
        // Lock this specific row independently of the table above so
        // a cosmetic "let's flip drill-down for readers" PR can't
        // sneak through review unnoticed.
        expect(getOrgPermissions('ORG_READER').canDrillDown).toBe(false);
    });

    it('tenant management is the owner\'s; member management is the admin\'s too (#4576)', () => {
        expect(getOrgPermissions('ORG_OWNER').canManageTenants).toBe(true);
        expect(getOrgPermissions('ORG_ADMIN').canManageTenants).toBe(false);
        expect(getOrgPermissions('ORG_ADMIN').canManageMembers).toBe(true);
        expect(getOrgPermissions('ORG_ADMIN').canManageOwners).toBe(false);
    });

    it('ORG_READER cannot manage tenants OR members', () => {
        const p = getOrgPermissions('ORG_READER');
        expect(p.canManageTenants).toBe(false);
        expect(p.canManageMembers).toBe(false);
    });
});
