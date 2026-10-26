/**
 * `borrowedMemberAuthority` — the authority a sweep carries for a member it
 * BORROWS (the oldest OWNER/ADMIN, the most senior member) — reads that
 * member's custom role (#4388, owner decision 2026-10-26).
 *
 *   - A custom role resolves exactly as a request resolves it: the role, coarse
 *     flags and granular set `resolveTenantContext` gives the same row.
 *   - A built-in role keeps exactly what the sweep carried before: its granular
 *     set and the coarse flags the sweep projects from it. That projection is
 *     NOT a request's for EDITOR, READER and AI_ADMIN (`canAudit`), so taking a
 *     request's flags there would change a built-in role's authority.
 */
const prismaMock = {
    tenant: { findUnique: jest.fn() },
    tenantMembership: { findUnique: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

import type { Role } from '@prisma/client';
import { borrowedMemberAuthority } from '@/app-layer/context-system';
import { resolveTenantContext, computePermissions, type Permissions } from '@/lib/tenant-context';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';

const BUILT_IN: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'AI_ADMIN'];

const ADMIN = getPermissionsForRole('ADMIN');
const READER = getPermissionsForRole('READER');

/** A sweep's projection, as the posture summary writes it. */
function projection(p: PermissionSet): Permissions {
    return {
        canRead: p.controls.view,
        canWrite: p.controls.create,
        canAdmin: p.admin.manage,
        canAudit: p.audits.view,
        canExport: p.reports.export,
    };
}

function row(role: Role, customRole: { baseRole: Role; permissionsJson: unknown } | null) {
    return {
        id: 'm-1',
        tenantId: 'tenant-A',
        userId: 'user-1',
        role,
        status: 'ACTIVE',
        customRoleId: customRole ? 'cr-1' : null,
        customRole: customRole
            ? { id: 'cr-1', tenantId: 'tenant-A', name: 'Custom', isActive: true, ...customRole }
            : null,
    };
}

async function requestAuthority(membership: ReturnType<typeof row>) {
    prismaMock.tenant.findUnique.mockResolvedValue({ id: 'tenant-A', slug: 'acme', deletedAt: null });
    prismaMock.tenantMembership.findUnique.mockResolvedValue(membership);
    const t = await resolveTenantContext({ tenantId: 'tenant-A' }, 'user-1');
    return { role: t.role, permissions: t.permissions, appPermissions: t.appPermissions };
}

beforeEach(() => jest.clearAllMocks());

describe('a borrowed member with a custom role carries what a request from them carries', () => {
    const cases: Array<[string, ReturnType<typeof row>]> = [
        [
            'an ADMIN-based role withholding risks.view',
            row('ADMIN', { baseRole: 'ADMIN', permissionsJson: { risks: { ...ADMIN.risks, view: false } } }),
        ],
        ['an ADMIN membership carrying a READER-based role', row('ADMIN', { baseRole: 'READER', permissionsJson: {} })],
        [
            'a READER-based role granting policies.edit, which does not lift the coarse write flag',
            row('ADMIN', { baseRole: 'READER', permissionsJson: { policies: { ...READER.policies, edit: true } } }),
        ],
    ];

    it.each(cases)('%s', async (_label, membership) => {
        const borrowed = borrowedMemberAuthority(membership, projection);
        expect(borrowed).toEqual(await requestAuthority(membership));
        // Not the built-in role the membership row names.
        expect(borrowed.appPermissions).not.toEqual(getPermissionsForRole(membership.role));
    });
});

describe('a borrowed member with a built-in role keeps exactly what the sweep carried before', () => {
    it.each(BUILT_IN)('%s', (role) => {
        const before = getPermissionsForRole(role);
        expect(borrowedMemberAuthority({ role, customRole: null }, projection)).toEqual({
            role,
            permissions: projection(before),
            appPermissions: before,
        });
    });

    it('for OWNER and ADMIN that is a request’s coarse flags too; for the others, canAudit is not', () => {
        const differs = BUILT_IN.filter((role) => {
            const p = borrowedMemberAuthority({ role, customRole: null }, projection).permissions;
            const request = computePermissions(role);
            return (Object.keys(request) as Array<keyof Permissions>).some((flag) => p[flag] !== request[flag]);
        });
        expect(differs).toEqual(['EDITOR', 'READER', 'AI_ADMIN']);
    });
});
