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

const ROOT = path.resolve(__dirname, '../..');

const MEMBER_MGMT_FILES = [
    'src/app/api/t/[tenantSlug]/admin/members/route.ts',
    'src/app/api/t/[tenantSlug]/admin/members/[membershipId]/route.ts',
];

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
    it.each(MEMBER_MGMT_FILES)(
        '%s includes OWNER in its role enum',
        (file) => {
            const content = readFile(file);
            expect(content).toMatch(ROLE_ENUM_PATTERN);
            const match = content.match(ROLE_ENUM_PATTERN);
            expect(match).not.toBeNull();
            expect(match![0]).toMatch(/['"]OWNER['"]/);
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
