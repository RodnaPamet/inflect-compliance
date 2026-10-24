/**
 * Which Risks bulk actions a user is offered — the same two gates the
 * bulk routes and usecases hold.
 *
 * The list used to offer Set status, Assign owner and Delete to every role,
 * so a READER's status change and an EDITOR's delete each ended in "Bulk
 * action failed". `riskBulkPermissions` decides from the request context the
 * server page already holds; this file pins it against the real resolvers
 * (`computePermissions` for the coarse tier the usecases assert,
 * `getPermissionsForRole` / `parsePermissionsJson` for the key the routes
 * check), so a change to either permission model lands here.
 */
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole, parsePermissionsJson } from '@/lib/permissions';
import { TENANT_ROLES } from '@/lib/roles';
import { riskBulkPermissions } from '@/app/t/[tenantSlug]/(app)/risks/_shared/bulk-permissions';
import type { Role } from '@prisma/client';

const forBuiltIn = (role: Role) =>
    riskBulkPermissions({ permissions: computePermissions(role), appPermissions: getPermissionsForRole(role) });

describe('riskBulkPermissions — built-in roles', () => {
    const expected: Record<Role, { canEdit: boolean; canDelete: boolean }> = {
        OWNER: { canEdit: true, canDelete: true },
        ADMIN: { canEdit: true, canDelete: true },
        EDITOR: { canEdit: true, canDelete: false },
        READER: { canEdit: false, canDelete: false },
        AUDITOR: { canEdit: false, canDelete: false },
        AI_ADMIN: { canEdit: false, canDelete: false },
    };

    it('covers every tenant role', () => {
        expect(Object.keys(expected).sort()).toEqual([...TENANT_ROLES].sort());
    });

    it.each(TENANT_ROLES.map((r) => [r]))('%s', (role) => {
        expect(forBuiltIn(role as Role)).toEqual(expected[role as Role]);
    });
});

describe('riskBulkPermissions — a custom role needs both gates', () => {
    it('a READER-based role granted risks.edit is still refused by assertCanWrite, so it gets no edit actions', () => {
        const appPermissions = parsePermissionsJson({ risks: { view: true, create: true, edit: true } }, 'READER');
        expect(appPermissions.risks.edit).toBe(true);
        expect(riskBulkPermissions({ permissions: computePermissions('READER'), appPermissions })).toEqual({
            canEdit: false,
            canDelete: false,
        });
    });

    it('an EDITOR-based role granted admin.manage is still refused by assertCanAdmin, so it gets no delete', () => {
        const base = getPermissionsForRole('EDITOR');
        const appPermissions = { ...base, admin: { ...base.admin, manage: true } };
        expect(riskBulkPermissions({ permissions: computePermissions('EDITOR'), appPermissions })).toEqual({
            canEdit: true,
            canDelete: false,
        });
    });

    it('an ADMIN-based role with risks.edit removed is refused by the status and assign routes', () => {
        const base = getPermissionsForRole('ADMIN');
        const appPermissions = { ...base, risks: { ...base.risks, edit: false } };
        expect(riskBulkPermissions({ permissions: computePermissions('ADMIN'), appPermissions })).toEqual({
            canEdit: false,
            canDelete: true,
        });
    });
});
