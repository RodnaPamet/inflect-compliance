/**
 * Membership-Only Identity Guardrails
 *
 * Ensures that:
 *   1. No code reads User.tenantId or User.role directly
 *   2. TenantMembership is the sole source of truth for tenant/role binding
 *   3. Schema no longer has deprecated fields
 *   4. Auth resolves from membership, not user-level fields
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const SRC_DIR = path.resolve(__dirname, '../../src');
/**
 * Comments MASKED at the read seam (#2246). Offsets and newlines survive, so
 * the `file:line` violation reports below still point at the right line; the
 * masking supersedes the per-line `startsWith('//')` skips, which never saw a
 * trailing or block comment, and it stops `dbUser.role` in prose from
 * failing (or satisfying) the whole-file `toContain` checks.
 */
function readSrcFile(relativePath: string): string {
    return codeOf(fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf-8'));
}

async function getFiles(pattern: string, baseDir: string = SRC_DIR): Promise<string[]> {
    return glob(pattern, { cwd: baseDir, posix: true });
}

// ─── Schema Guardrails ──────────────────────────────────────────────

describe('Schema: User model has no deprecated fields', () => {
    let schema: string;

    beforeAll(() => {
        schema = readPrismaSchema();
    });

    it('User model does not have tenantId field', () => {
        // Extract the User model block
        const userModelMatch = schema.match(/model User \{[\s\S]*?\n\}/);
        expect(userModelMatch).toBeTruthy();
        const userModel = userModelMatch![0];
        expect(userModel).not.toMatch(/^\s+tenantId\s+String/m);
    });

    it('User model does not have role field', () => {
        const userModelMatch = schema.match(/model User \{[\s\S]*?\n\}/);
        expect(userModelMatch).toBeTruthy();
        const userModel = userModelMatch![0];
        expect(userModel).not.toMatch(/^\s+role\s+Role/m);
    });

    it('User model does not have tenant relation', () => {
        const userModelMatch = schema.match(/model User \{[\s\S]*?\n\}/);
        expect(userModelMatch).toBeTruthy();
        const userModel = userModelMatch![0];
        expect(userModel).not.toMatch(/tenant\s+Tenant\??\s+@relation/);
    });

    it('TenantMembership model has role and tenantId', () => {
        const membershipMatch = schema.match(/model TenantMembership \{[\s\S]*?\n\}/);
        expect(membershipMatch).toBeTruthy();
        const membership = membershipMatch![0];
        expect(membership).toMatch(/^\s+tenantId\s+String/m);
        expect(membership).toMatch(/^\s+role\s+Role/m);
    });
});

// ─── Code Guardrails ────────────────────────────────────────────────

describe('No code reads deprecated User.tenantId / User.role', () => {
    /**
     * Files allowed to reference .tenantId (but NOT on User):
     * - These reference tenantId on TenantMembership, RequestContext, session, etc.
     * We scan for patterns that specifically access User.tenantId or User.role.
     */

    it('no Prisma User queries select/include role or tenantId', async () => {
        const tsFiles = await getFiles('**/*.ts');
        const violations: string[] = [];

        for (const file of tsFiles) {
            const content = readSrcFile(file);
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Skip comments
                if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

                // Pattern: prisma.user.create/update with { role: or tenantId: in data
                // We look for User create/update patterns that set deprecated fields
                if (
                    /user\.(create|update|upsert)\s*\(/.test(line) ||
                    // Single-line data with role or tenantId in user context
                    (/create:\s*\{/.test(line) && /tenantId:.*email:/.test(line))
                ) {
                    // Check if this line also sets role as a User field (not membership)
                    if (/role:\s*['"](?:ADMIN|EDITOR|READER|AUDITOR)['"]/.test(line) &&
                        !file.includes('membership') && !file.includes('Membership')) {
                        violations.push(`${file}:${i + 1}: deprecated User.role in create/update`);
                    }
                }
            }
        }

        if (violations.length > 0) {
            fail(
                `Found ${violations.length} Prisma User query(ies) setting deprecated role/tenantId:\n` +
                violations.map(v => `  ${v}`).join('\n') +
                '\n\nUse TenantMembership to set role and tenant binding instead.',
            );
        }
    });

    it('no direct user.tenantId reads in non-test src/ files', async () => {
        const tsFiles = await getFiles('**/*.{ts,tsx}');
        const violations: string[] = [];

        // Pattern: accessing .tenantId on a variable likely named "user" or "dbUser"
        const dangerousPatterns = [
            /(?:user|dbUser)\.tenantId/,
        ];

        for (const file of tsFiles) {
            const content = readSrcFile(file);
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

                for (const pattern of dangerousPatterns) {
                    if (pattern.test(line)) {
                        // Allow session.user.tenantId (that's from JWT/session, not DB model)
                        if (line.includes('session.user.tenantId')) continue;
                        violations.push(`${file}:${i + 1}: ${line.trim().substring(0, 80)}`);
                    }
                }
            }
        }

        if (violations.length > 0) {
            fail(
                `Found ${violations.length} direct user.tenantId read(s):\n` +
                violations.map(v => `  ${v}`).join('\n') +
                '\n\nResolve tenantId from TenantMembership instead.',
            );
        }
    });

    it('no direct user.role reads in non-test src/ files', async () => {
        const tsFiles = await getFiles('**/*.{ts,tsx}');
        const violations: string[] = [];

        for (const file of tsFiles) {
            const content = readSrcFile(file);
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

                // Match user.role but NOT session.user.role, membership.role, ctx.role
                if (/(?:user|dbUser)\.role\b/.test(line)) {
                    // Allow session.user.role (JWT-derived), token.role
                    if (line.includes('session.user.role')) continue;
                    if (line.includes('token.role')) continue;
                    violations.push(`${file}:${i + 1}: ${line.trim().substring(0, 80)}`);
                }
            }
        }

        if (violations.length > 0) {
            fail(
                `Found ${violations.length} direct user.role read(s):\n` +
                violations.map(v => `  ${v}`).join('\n') +
                '\n\nResolve role from TenantMembership instead.',
            );
        }
    });
});

// ─── Auth Flow Guardrails ───────────────────────────────────────────

describe('Auth resolves identity from membership', () => {
    it('JWT callback resolves from tenantMemberships, not User fields', () => {
        const authContent = readSrcFile('../src/auth.ts');
        // Must include tenantMemberships in the JWT callback
        expect(authContent).toContain('tenantMemberships');
        // Must NOT contain fallback to deprecated fields
        expect(authContent).not.toContain('dbUser.tenantId');
        expect(authContent).not.toContain('dbUser.role');
    });

    it('register handler creates membership, not user-level role', () => {
        const registerContent = readSrcFile('app/api/auth/register/route.ts');
        // Must create membership
        expect(registerContent).toContain('tenantMembership.create');
        // Must NOT set role directly on the User model
        // (membership.create is separate and correctly sets role there)
        const userCreateMatch = registerContent.match(/user\.create\(\{[\s\S]*?\}\s*\)/);
        if (userCreateMatch) {
            expect(userCreateMatch[0]).not.toContain("role:");
        }
    });

    it('login resolves from membership, not user.tenant', () => {
        // The credentials login path moved from /api/auth/register (where
        // it historically lived under `action: 'login'`) into the
        // NextAuth Credentials provider — `src/lib/auth/credentials.ts`
        // via `authenticateWithPassword`. That's where membership
        // resolution must now appear. The JWT callback in `src/auth.ts`
        // also touches the membership shape; either path satisfies the
        // guardrail.
        const credentialsContent = readSrcFile('lib/auth/credentials.ts');
        const authContent = readSrcFile('auth.ts');
        const combined = credentialsContent + '\n' + authContent;
        // Must include membership in the identity resolution path
        expect(combined).toContain('tenantMemberships');
        // Must derive role from membership (via JWT or callback).
        // R-1: auth.ts now builds memberships[] using m.role inside .map();
        // m.role is unambiguously membership-derived, so allow that pattern too.
        expect(combined).toMatch(/membership\?\.role|defaultMembership\.role|membership\.role|m\.role/);
    });

    it('me endpoint resolves from membership', () => {
        const meContent = readSrcFile('app/api/auth/me/route.ts');
        expect(meContent).toContain('tenantMemberships');
        expect(meContent).not.toContain("select: { id: true, email: true, name: true, role: true, tenantId: true }");
    });
});
