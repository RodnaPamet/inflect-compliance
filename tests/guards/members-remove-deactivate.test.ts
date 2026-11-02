/**
 * Members admin — remove/deactivate actions (structural ratchet).
 *
 *   1. A hard-remove usecase + DELETE route exist (only soft-deactivate did).
 *   2. The members page has a top action row (BulkActionBar) with
 *      deactivate + remove, wired to DataTable selection.
 *   3. The per-row three-dot menu uses the portal-based Popover (the old
 *      in-cell absolute dropdown was clipped by the table's overflow) and
 *      offers Remove alongside Deactivate.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const USECASE = 'src/app-layer/usecases/tenant-admin.ts';
const ROUTE = 'src/app/api/t/[tenantSlug]/admin/members/[membershipId]/route.ts';
const PAGE = 'src/app/t/[tenantSlug]/(app)/admin/members/page.tsx';

describe('members remove/deactivate (1) hard-remove backend', () => {
    it('removeTenantMember usecase enforces self + last-OWNER protection', () => {
        const src = read(USECASE);
        expect(src).toMatch(/export async function removeTenantMember/);
        expect(src).toMatch(/tenantMembership\.delete/);
        expect(src).toMatch(/Cannot remove your own membership/);
        expect(src).toMatch(/Cannot remove the last OWNER/);
    });
    it('a DELETE route is wired to removeTenantMember behind admin.members', () => {
        const src = read(ROUTE);
        expect(src).toMatch(/export const DELETE/);
        expect(src).toMatch(/removeTenantMember/);
        expect(src).toMatch(/requirePermission<[^>]*>\(\s*'admin\.members'/);
    });
});

describe('members remove/deactivate (2) top action row', () => {
    const src = read(PAGE);
    it('the members DataTable enables selection + a BulkActionBar', () => {
        expect(src).toMatch(/BulkActionBar/);
        expect(src).toMatch(/selectionEnabled/);
        expect(src).toMatch(/onRowSelectionChange/);
    });
    it('the bulk actions are deactivate + remove', () => {
        expect(src).toMatch(/value: 'deactivate'/);
        expect(src).toMatch(/value: 'remove'/);
        expect(src).toMatch(/handleBulkApply/);
    });
});

describe('members remove/deactivate (3) three-dot menu fixed + Remove', () => {
    const src = read(PAGE);
    it('the row menu uses the portal Popover, not a clipped absolute dropdown', () => {
        expect(src).toMatch(/<Popover\b/);
        expect(src).toMatch(/Popover\.Item/);
        // the old clipped in-cell dropdown is gone
        expect(src).not.toMatch(/absolute right-0 top-full mt-1 bg-bg-default/);
    });
    it('the menu offers Remove and Deactivate', () => {
        expect(src).toMatch(/action-remove-\$\{m\.id\}/);
        expect(src).toMatch(/action-deactivate-\$\{m\.id\}/);
        // Through the confirm dialog, not the browser's `confirm()` (#4989).
        expect(src).toMatch(/kind: 'remove', membershipId: m\.id/);
        expect(src).toMatch(/handleRemove\(pending\.membershipId/);
        expect(src).not.toMatch(/\bconfirm\(t\(/);
    });
});

describe('members remove/deactivate i18n parity', () => {
    const en = JSON.parse(read('messages/en.json'));
    const bg = JSON.parse(read('messages/bg.json'));
    it('new member keys exist in both locales', () => {
        for (const l of [en, bg]) {
            expect(l.admin.members.remove).toBeTruthy();
            expect(l.admin.members.removeConfirmTitle).toBeTruthy();
            expect(l.admin.members.removeConfirmBody).toBeTruthy();
            expect(l.admin.members.removalFailed).toBeTruthy();
            expect(l.admin.members.bulkRemovedToast).toBeTruthy();
            expect(l.admin.members.bulkDeactivatedToast).toBeTruthy();
        }
    });
});
