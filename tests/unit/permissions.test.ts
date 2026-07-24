import { getPermissionsForRole } from '@/lib/permissions';
import { hasPermission } from '@/lib/security/permission-middleware';

describe('Permissions Map', () => {
    it('grants full access to ADMIN', () => {
        const permissions = getPermissionsForRole('ADMIN');

        // Check a random sample of critical permissions
        expect(permissions.controls.edit).toBe(true);
        expect(permissions.policies.approve).toBe(true);
        expect(permissions.admin.manage).toBe(true);
        expect(permissions.audits.freeze).toBe(true);
        expect(permissions.frameworks.install).toBe(true);
    });

    it('grants limited write access to EDITOR', () => {
        const permissions = getPermissionsForRole('EDITOR');

        // Editors can create/edit but not approve/admin
        expect(permissions.controls.edit).toBe(true);
        expect(permissions.evidence.upload).toBe(true);

        expect(permissions.policies.approve).toBe(false);
        expect(permissions.admin.manage).toBe(false);
        expect(permissions.frameworks.install).toBe(false);
    });

    it('grants read-only and specific audit access to AUDITOR', () => {
        const permissions = getPermissionsForRole('AUDITOR');

        // Auditors can view and download, but not edit
        expect(permissions.controls.view).toBe(true);
        expect(permissions.evidence.download).toBe(true);

        expect(permissions.controls.edit).toBe(false);
        expect(permissions.evidence.upload).toBe(false);

        // Auditors can share audits
        expect(permissions.audits.share).toBe(true);
        expect(permissions.audits.freeze).toBe(false);
    });

    it('grants strict read-only access to READER', () => {
        const permissions = getPermissionsForRole('READER');

        expect(permissions.controls.view).toBe(true);
        expect(permissions.evidence.download).toBe(true);

        expect(permissions.controls.edit).toBe(false);
        expect(permissions.policies.approve).toBe(false);
        expect(permissions.admin.manage).toBe(false);
        expect(permissions.reports.export).toBe(false);
    });
});

// The report export routes (POST /reports/pdf/generate, GET
// /reports/soa/export.csv, POST /risks/reports) are wrapped with
// requirePermission('reports.export', …), which gates on hasPermission(...).
// This locks in that a READER is denied while every writer/exporter role is
// allowed — the exact resolution the middleware performs.
describe('reports.export gate (requirePermission key)', () => {
    it('denies READER', () => {
        expect(
            hasPermission(getPermissionsForRole('READER'), 'reports.export'),
        ).toBe(false);
    });

    it.each(['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR'] as const)(
        'allows %s',
        (role) => {
            expect(
                hasPermission(getPermissionsForRole(role), 'reports.export'),
            ).toBe(true);
        },
    );
});
