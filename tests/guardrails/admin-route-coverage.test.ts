/**
 * Guardrail test: Admin API route authorization coverage.
 *
 * Scans all admin-only API route files to ensure they import a centralised
 * authorization guard rather than raw `getTenantCtx`.
 *
 * Accepted guard:
 *   - `requirePermission` — the sole admin-authorization guard
 *     (Epic C.1 — granular PermissionKey). The legacy role-tier
 *     helpers (`requireAdminCtx` / `requireWriteCtx` / `requireRoleCtx`)
 *     were removed once every route had migrated; the ratchet at
 *     `no-legacy-admin-guard.test.ts` keeps them from returning.
 *
 * Adding a new admin route? Wrap the handler with
 * `requirePermission('admin.X', …)` from
 * `@/lib/security/permission-middleware` and add the URL to
 * `ROUTE_PERMISSIONS` in `@/lib/security/route-permissions`. The
 * companion guardrail `tests/guardrails/api-permission-coverage.test.ts`
 * verifies the route ↔ map sync.
 */
import * as fs from 'fs';
import * as path from 'path';

// ─── Configuration ───

/**
 * Routes that MUST use the centralized `requirePermission` guard.
 *
 * Format: relative path from src/app/api/t/[tenantSlug]/
 * Every route file listed here is checked for the centralized admin guard import.
 */
const ADMIN_ONLY_ROUTES = [
    'admin/calendar/consent/route.ts',
    // /admin/* routes
    'admin/members/route.ts',
    'admin/members/[membershipId]/route.ts',
    'admin/members/[membershipId]/deactivate/route.ts',
    'admin/settings/route.ts',
    'admin/scim/route.ts',
    'admin/integrations/route.ts',
    'admin/integrations/diagnostics/route.ts',
    'admin/integrations/health/route.ts',
    // P1 — connection-level run + per-connection outcomes + identity roster.
    'admin/integrations/[connectionId]/sync/route.ts',
    'admin/integrations/[connectionId]/executions/route.ts',
    'admin/integrations/identity-accounts/route.ts',
    // SP-1 — SharePoint connection management (delegated-consent OAuth)
    'admin/integrations/sharepoint/route.ts',
    'admin/integrations/sharepoint/connect/route.ts',
    'admin/integrations/sharepoint/sites/route.ts',
    'admin/integrations/sharepoint/test/route.ts',
    'admin/roles/route.ts',
    'admin/roles/[roleId]/route.ts',
    // Trust Center — compose (ADMIN) + publish toggle (OWNER). Both use
    // requirePermission; publishing the public page is OWNER-gated.
    'admin/trust-center/route.ts',
    'admin/trust-center/enable/route.ts',
    'admin/api-keys/route.ts',
    'admin/api-keys/[keyId]/route.ts',
    'admin/device-tokens/route.ts',
    'admin/device-tokens/[tokenId]/route.ts',
    'admin/dsar-requests/route.ts',
    'admin/trust-center/documents/route.ts',
    'admin/trust-center/requests/route.ts',
    'admin/trust-center/requests/[requestId]/approve/route.ts',
    'admin/key-rotation/route.ts',
    'admin/tenant-dek-rotation/route.ts',
    'admin/billing/plan/route.ts',
    'admin/rotate-dek/route.ts',
    'admin/sessions/route.ts',
    // Epic 1, PR 3 — token-redemption invite flow (admin invite management)
    'admin/invites/route.ts',
    'admin/invites/[inviteId]/route.ts',

    // Epic 44 — risk matrix configuration
    'admin/risk-matrix-config/route.ts',
    // Tenant security settings — session cap, audit-stream endpoint + HMAC
    // secret, AI guard mode + residency. Admin-only on BOTH verbs: the read
    // reveals whether an outbound streaming endpoint is configured.
    'admin/security-settings/route.ts',

    // Billing routes (admin-only)
    'billing/checkout/route.ts',
    'billing/portal/route.ts',
    'billing/events/route.ts',

    // SSO configuration (admin-only)
    'sso/route.ts',

    // Security management (admin-only mutation/operations)
    'security/sessions/revoke-user/route.ts',
    'security/sessions/revoke-all/route.ts',
    'security/mfa/policy/route.ts',
];

/**
 * The import pattern that indicates proper admin authorization.
 *
 * `requirePermission` (Epic C.1) is the sole canonical guard — the
 * legacy `require*Ctx` role helpers were removed once every route had
 * migrated, so this is now a single-element list.
 */
const ADMIN_GUARD_PATTERNS = [
    'requirePermission',
];

const BASE_DIR = path.resolve(
    __dirname,
    '../../src/app/api/t/[tenantSlug]'
);

// ─── Tests ───

describe('Admin API route authorization coverage', () => {
    // Verify each admin route imports the centralized guard
    for (const routePath of ADMIN_ONLY_ROUTES) {
        const displayPath = `api/t/[tenantSlug]/${routePath}`;

        test(`${displayPath} uses centralized admin guard`, () => {
            const fullPath = path.join(BASE_DIR, routePath);

            // Route file must exist
            expect(fs.existsSync(fullPath)).toBe(true);

            const content = fs.readFileSync(fullPath, 'utf-8');

            // Must import at least one admin guard utility
            const hasGuard = ADMIN_GUARD_PATTERNS.some(pattern =>
                content.includes(pattern)
            );

            expect(hasGuard).toBe(true);

            // Must NOT use raw getTenantCtx (which skips role check)
            // Exception: if the file also imports a guard, it may use getTenantCtx
            // for non-admin handlers (e.g. GET that's read-only). We check that
            // the guard import exists — that's the critical assertion.
        });
    }

    // Scan for new admin/* route files not in the allowlist
    test('no admin/* route file exists without being listed in ADMIN_ONLY_ROUTES', () => {
        const adminDir = path.join(BASE_DIR, 'admin');
        if (!fs.existsSync(adminDir)) return;

        const routeFiles: string[] = [];
        function walk(dir: string, prefix: string) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    walk(path.join(dir, entry.name), rel);
                } else if (entry.name === 'route.ts') {
                    routeFiles.push(`admin/${rel}`);
                }
            }
        }
        walk(adminDir, '');

        const missing = routeFiles.filter(
            f => !ADMIN_ONLY_ROUTES.includes(f)
        );

        expect(missing).toEqual([]);
    });

    // Verify no admin route uses raw getTenantCtx without a guard
    test('no admin route uses raw getTenantCtx without an admin guard import', () => {
        const violations: string[] = [];

        for (const routePath of ADMIN_ONLY_ROUTES) {
            const fullPath = path.join(BASE_DIR, routePath);
            if (!fs.existsSync(fullPath)) continue;

            const content = fs.readFileSync(fullPath, 'utf-8');
            const hasGuard = ADMIN_GUARD_PATTERNS.some(p => content.includes(p));
            const usesRawCtx = content.includes('getTenantCtx');

            if (usesRawCtx && !hasGuard) {
                violations.push(routePath);
            }
        }

        expect(violations).toEqual([]);
    });
});
