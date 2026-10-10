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

import { codeOf } from '../helpers/source-blocks';

const SRC = path.resolve(__dirname, '../../src');

function readFile(relativePath: string): string {
    const fullPath = path.join(SRC, relativePath);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Expected file not found: ${fullPath}`);
    }
    // MASKED at the read seam (#3309 revealed this file was reading raw).
    // `codeOf` blanks comments and keeps string literals with offsets
    // preserved, so an assertion cannot be satisfied by a note explaining
    // code that is no longer there.
    return codeOf(fs.readFileSync(fullPath, 'utf-8'));
}

describe('RBAC Guardrail Scans', () => {
    describe('Admin route guards', () => {
        test('admin layout guard exists and uses RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/admin/layout.tsx');
            // Centralized layout guard must use RequirePermission with admin resource
            // Needles that name a CONSTRUCT, not an identifier (#3364).
            // `/RequirePermission/` matched the import, the opening tag and
            // the closing tag alike, so none of the three was the thing
            // asserted; `<RequirePermission` names the element.
            expect(content).toMatch(/<RequirePermission/);
            expect(content).toMatch(/resource="admin"/);
            // Must render ForbiddenPage for unauthorized access
            expect(content).toMatch(/<ForbiddenPage/);
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
            // The ASSIGNMENT, not the word: the identifier appears in the
            // import, the read and the prop pass (#3364).
            expect(content).toMatch(/appPermissions\s*=/);
        });

        test('controls client island receives and enforces create/edit permissions', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx');
            // Client island must declare create and edit permission props
            // The whole prop SHAPE in one needle (#3364). `/edit.*boolean/`
            // also matched `tasks: { edit: boolean }`, so the controls perms
            // this test is named for were not the only thing satisfying it.
            expect(content).toMatch(
                /controls:\s*\{\s*create:\s*boolean;\s*edit:\s*boolean\s*\}/,
            );
        });
    });

    describe('Audit pack RBAC', () => {
        test('freeze button is wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx');
            // ONE needle naming the element AND its props (#3364).
            // `/RequirePermission/` occurred 17 times in this file, and the
            // separate `resource=`/`action=` needle never asserted that the
            // pair was on a RequirePermission element at all.
            expect(content).toMatch(/<RequirePermission resource="audits" action="freeze"/);
        });

        test('share button is wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx');
            // Three share controls, all of which must be wrapped (#3364).
            expect(
                content.match(/<RequirePermission resource="audits" action="share"/g),
            ).toHaveLength(3);
        });

        test('clone button is wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx');
            // Four manage controls, all of which must be wrapped (#3364).
            expect(
                content.match(/<RequirePermission resource="audits" action="manage"/g),
            ).toHaveLength(4);
        });
    });

    describe('Policies page RBAC', () => {
        test('policies server page resolves permissions and passes to client island', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/policies/page.tsx');
            // Server component must resolve tenant context (which includes permissions)
            // The CALL, not the import too (#3364).
            expect(content).toMatch(/getTenantCtx\(\{ tenantSlug \}\)/);
            // Must pass permissions to client island
            expect(content).toMatch(/permissions=\{/);
        });
    });

    describe('Risks page RBAC', () => {
        test('risks server page resolves permissions and passes to client island', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/risks/page.tsx');
            // Server component must resolve tenant context (which includes permissions)
            // The CALL, not the import too (#3364).
            expect(content).toMatch(/getTenantCtx\(\{ tenantSlug \}\)/);
            // Must pass permissions to client island
            expect(content).toMatch(/permissions=\{/);
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
            // COUNTED, because there are two install controls and the claim
            // is that BOTH are wrapped (#3364). A `toMatch` could not tell
            // "both wrapped" from "one wrapped and one bare", which is the
            // regression that matters here.
            expect(
                content.match(/<RequirePermission resource="frameworks" action="install"/g),
            ).toHaveLength(2);
        });
    });

    describe('Reports RBAC', () => {
        test('reports export buttons are wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/reports/ReportsClient.tsx');
            // COUNTED — three export controls, all of which must be wrapped.
            expect(
                content.match(/<RequirePermission resource="reports" action="export"/g),
            ).toHaveLength(3);
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
            expect(
                content.match(/<RequirePermission resource="reports" action="export"/g),
            ).toHaveLength(3);
            // The SoA-specific export anchors must still exist
            // somewhere on the page — assert by id so a future
            // refactor that drops the export entirely fails CI.
            expect(content).toContain('id="export-soa-btn"');
        });
    });

    describe('Navigation RBAC', () => {
        test('SidebarNav filters hidden items by permission', () => {
            const content = readFile('components/layout/SidebarNav.tsx');
            // Both nav sections bind it, so COUNT rather than match (#3364):
            // one section losing its permission read is the regression.
            expect(content.match(/const perms = usePermissions\(\)/g)).toHaveLength(2);
            // Every nav entry's `visible` must be computed from `perms`,
            // so COUNT them rather than finding one (#3364). A new entry
            // hard-coding `visible: true` is the regression this now catches
            // and a single match never could.
            expect(content.match(/visible:\s*perms\./g)).toHaveLength(2);
            expect(content).toMatch(/\.filter\(/);
        });
    });

    describe('Core permission infrastructure', () => {
        test('RequirePermission component exists and uses usePermissions', () => {
            const content = readFile('components/require-permission.tsx');
            expect(content).toMatch(/usePermissions\(/);
            expect(content).toMatch(/const hasPermission = permissions\[resource\]\[action\]/);
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
            expect(content).toMatch(/appPermissions: serverCtx\.appPermissions/);
        });
    });
});
