/**
 * RBAC Guardrail Scan Tests
 *
 * These tests statically scan critical source files to ensure RBAC enforcement
 * patterns are present and haven't regressed. They don't test runtime behavior —
 * they verify that the right permission checks exist in the right files.
 *
 * If a test fails, it means someone removed or bypassed a required RBAC guard.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

function readFile(relativePath: string): string {
    const fullPath = path.join(SRC, relativePath);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Expected file not found: ${fullPath}`);
    }
    return fs.readFileSync(fullPath, 'utf-8');
}

describe('RBAC Guardrail Scans', () => {
    describe('Admin route guards', () => {
        test('admin layout guard exists and uses RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/admin/layout.tsx');
            // Centralized layout guard must use RequirePermission with admin resource
            expect(content).toMatch(/RequirePermission/);
            expect(content).toMatch(/resource="admin"/);
            // Must render ForbiddenPage for unauthorized access
            expect(content).toMatch(/ForbiddenPage/);
        });

        test('admin/rbac page does NOT have redundant per-page guard (uses layout)', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/admin/rbac/page.tsx');
            // Should NOT contain per-page guard — layout handles authorization
            expect(content).not.toMatch(/ServerForbiddenPage/);
            expect(content).not.toMatch(/RequirePermission/);
        });
    });

    describe('Controls page RBAC', () => {
        test('controls server page resolves appPerms and passes to client island', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/controls/page.tsx');
            // Server component must resolve permissions via ctx.appPermissions (from custom role resolution)
            expect(content).toMatch(/ctx\.appPermissions\.controls/);
            // Must pass appPermissions (including controls) to client island
            expect(content).toMatch(/appPermissions/);
        });

        test('controls client island receives and enforces create/edit permissions', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx');
            // Client island must declare create and edit permission props
            expect(content).toMatch(/create.*boolean/);
            expect(content).toMatch(/edit.*boolean/);
        });
    });

    describe('Audit pack RBAC', () => {
        test('freeze button is wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx');
            expect(content).toMatch(/RequirePermission/);
            expect(content).toMatch(/resource="audits" action="freeze"/);
        });

        test('share button is wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx');
            expect(content).toMatch(/resource="audits" action="share"/);
        });

        test('clone button is wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx');
            expect(content).toMatch(/resource="audits" action="manage"/);
        });
    });

    describe('Policies page RBAC', () => {
        test('policies server page resolves permissions and passes to client island', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/policies/page.tsx');
            // Server component must resolve tenant context (which includes permissions)
            expect(content).toMatch(/getTenantCtx/);
            // Must pass permissions to client island
            expect(content).toMatch(/permissions/);
        });
    });

    describe('Risks page RBAC', () => {
        test('risks server page resolves permissions and passes to client island', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/risks/page.tsx');
            // Server component must resolve tenant context (which includes permissions)
            expect(content).toMatch(/getTenantCtx/);
            // Must pass permissions to client island
            expect(content).toMatch(/permissions/);
        });
    });

    // Tasks page RBAC was two regexes over TasksClient.tsx source
    // (`appPermissions.tasks.create` / `.edit`). B3-2 replaced them with
    // `tests/rendered/tasks-list-role-surface.test.tsx`, which mounts the
    // page as each of the five roles and asserts the write surface a user
    // actually gets — the create button, the quick-edit pencil and the
    // bulk bar are absent for READER and AUDITOR, not merely disabled.
    // A regex could not tell "reads the flag" from "reads the flag and
    // then renders the button anyway".

    describe('Vendors page RBAC', () => {
        test('vendor create button uses appPerms', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/vendors/page.tsx');
            expect(content).toMatch(/appPermissions\.vendors\.create/);
        });
    });

    describe('Frameworks page RBAC', () => {
        test('install pack buttons are wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/page.tsx');
            expect(content).toMatch(/RequirePermission/);
            expect(content).toMatch(/resource="frameworks" action="install"/);
        });
    });

    describe('Reports RBAC', () => {
        test('reports export buttons are wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/reports/ReportsClient.tsx');
            expect(content).toMatch(/RequirePermission/);
            expect(content).toMatch(/resource="reports" action="export"/);
        });

        test('SoA export buttons are wrapped in RequirePermission', () => {
            // Roadmap-2 PR-12 — the SoA export buttons (CSV +
            // Audit Readiness PDF + Gap Analysis PDF) lifted up
            // from SoAClient into the Reports page header so the
            // user sees ONE export cluster, tab-aware. The
            // RequirePermission gate is now in ReportsClient
            // wrapping the tab-aware buttons; the test still
            // anchors there.
            const content = readFile('app/t/[tenantSlug]/(app)/reports/ReportsClient.tsx');
            expect(content).toMatch(/RequirePermission/);
            expect(content).toMatch(/resource="reports" action="export"/);
            // The SoA-specific export anchors must still exist
            // somewhere on the page — assert by id so a future
            // refactor that drops the export entirely fails CI.
            expect(content).toContain('id="export-soa-btn"');
        });
    });

    describe('Navigation RBAC', () => {
        test('SidebarNav filters hidden items by permission', () => {
            const content = readFile('components/layout/SidebarNav.tsx');
            expect(content).toMatch(/usePermissions/);
            expect(content).toMatch(/visible.*perms\./);
            expect(content).toMatch(/\.filter\(/);
        });
    });

    describe('Core permission infrastructure', () => {
        test('RequirePermission component exists and uses usePermissions', () => {
            const content = readFile('components/require-permission.tsx');
            expect(content).toMatch(/usePermissions/);
            expect(content).toMatch(/hasPermission/);
        });

        test('PermissionSet type covers all critical resources', () => {
            const content = readFile('lib/permissions.ts');
            const requiredResources = ['controls', 'evidence', 'policies', 'tasks', 'risks', 'vendors', 'tests', 'frameworks', 'audits', 'reports', 'admin'];
            for (const resource of requiredResources) {
                expect(content).toContain(`${resource}:`);
            }
        });

        test('TenantProvider passes appPermissions', () => {
            const content = readFile('app/t/[tenantSlug]/layout.tsx');
            expect(content).toMatch(/appPermissions/);
        });
    });
});
