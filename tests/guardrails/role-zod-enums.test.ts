/**
 * Guardrail: every Zod enum that parses a `Role` must include OWNER
 * iff the route it gates is a member-management surface that might
 * legitimately accept an OWNER value (invite, role-update). Routes
 * that intentionally exclude OWNER (custom-role baseRole, SCIM) are
 * on a carved exemption list.
 *
 * Rationale: OWNER was added in Epic 1 PR 1. A Zod schema still
 * enumerating `['ADMIN', 'EDITOR', 'AUDITOR', 'READER']` on an
 * invite/role endpoint silently rejects OWNER with a 400 instead
 * of honouring a legitimate OWNER promotion — subtle bug the type
 * system cannot catch because Zod enums are runtime-only.
 *
 * Keep this in lockstep with the Prisma `Role` enum shape.
 */

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../helpers/source-blocks';
import { ASSIGNABLE_TENANT_ROLES, MEMBER_ROLE_CHANGE_ROLES } from '@/lib/roles';

const ROOT = path.resolve(__dirname, '../..');

/** Each member-management route, and the shared list its `role` must validate against. */
const MEMBER_MGMT_FILES = [
    { file: 'src/app/api/t/[tenantSlug]/admin/members/route.ts', list: 'ASSIGNABLE_TENANT_ROLES' },
    {
        file: 'src/app/api/t/[tenantSlug]/admin/members/[membershipId]/route.ts',
        list: 'MEMBER_ROLE_CHANGE_ROLES',
    },
] as const;

const OWNER_EXEMPT_FILES: Array<{ file: string; reason: string }> = [
    {
        file: 'src/app/api/t/[tenantSlug]/admin/roles/route.ts',
        reason:
            'Custom-role baseRole. By design custom roles cannot anchor ' +
            'to OWNER — that tier is reserved for the built-in OWNER role.',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/admin/roles/[roleId]/route.ts',
        reason: 'Same rationale as the create route above.',
    },
];

const ROLE_ENUM_PATTERN = /z\.enum\(\[[^\]]*['"]ADMIN['"][^\]]*\]/;

function readFile(rel: string): string {
    return codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

describe('Role Zod enums include OWNER where member-management relevant', () => {
    /**
     * Since #3699 the member-management routes validate `role` against a
     * shared list in `src/lib/roles.ts` rather than a literal of their own:
     * `Role` gained AI_ADMIN, which the direct add (an invite) must refuse and
     * the role change (`MEMBER_ROLE_CHANGE_ROLES`, deploy 2) accepts for an
     * OWNER. So "includes OWNER" is asked of those lists, and the routes are
     * asked to use theirs and to carry no literal role enum beside it — a
     * second list is how the two would drift.
     */
    it('both lists the routes validate against include OWNER', () => {
        expect(ASSIGNABLE_TENANT_ROLES).toContain('OWNER');
        expect(MEMBER_ROLE_CHANGE_ROLES).toContain('OWNER');
    });

    it.each(MEMBER_MGMT_FILES)(
        '$file validates role against $list, and no literal role enum',
        ({ file, list }) => {
            const content = readFile(file);
            expect({
                fromSharedList: new RegExp(`role:\\s*z\\.enum\\(${list}\\)`).test(content),
                literalRoleEnum: ROLE_ENUM_PATTERN.test(content),
            }).toEqual({ fromSharedList: true, literalRoleEnum: false });
        },
    );

    it.each(OWNER_EXEMPT_FILES)(
        '%s intentionally omits OWNER from its role enum',
        ({ file }) => {
            const content = readFile(file);
            expect(content).toMatch(ROLE_ENUM_PATTERN);
            const match = content.match(ROLE_ENUM_PATTERN);
            expect(match).not.toBeNull();
            expect(match![0]).not.toMatch(/['"]OWNER['"]/);
        },
    );
});
