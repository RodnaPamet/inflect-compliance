/**
 * `/api/auth/register` is the only unauthenticated route that creates a
 * tenant. Three things about it were wrong regardless of signup policy.
 *
 * 1. It defeated its own error shaping. A local try/catch returned
 *    `error.message` verbatim with status 500, so raw Prisma text —
 *    constraint and column names, the invocation site, an absolute server
 *    path — reached an unauthenticated caller. The catch justified itself as
 *    "a final safety net so a DB error returns JSON instead of an HTML 500
 *    page", which is precisely what `withApiErrorHandling` already does,
 *    minus the disclosure.
 *
 * 2. It ran 720x looser than the credentialed path for the same operation.
 *    No options object meant the generic API_MUTATION_LIMIT (60/min), while
 *    TENANT_CREATE_LIMIT (5/hour) — written for exactly this threat — was
 *    wired only to the platform-key-GATED /api/admin/tenants. Each accepted
 *    request permanently creates a Tenant + wrapped per-tenant DEK + User +
 *    TenantMembership, runs bcrypt cost 12, makes an outbound HIBP call, and
 *    sends mail to an attacker-chosen recipient from our sending domain.
 *
 * 3. Every self-service tenant was born with ZERO owners. The first member
 *    was created as ADMIN, and OWNER is strictly superior — it alone carries
 *    `admin.tenant_lifecycle` and `admin.owner_management`. So those tenants
 *    could never delete themselves, rotate their own DEK, or transfer
 *    ownership. The platform-admin path (`createTenantWithOwner`) had always
 *    done this correctly; this one had drifted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TENANT_CREATE_LIMIT, API_MUTATION_LIMIT } from '@/lib/security/rate-limit';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ROUTE = 'src/app/api/auth/register/route.ts';

describe('register does not leak raw errors to anonymous callers', () => {
    it('has no local catch that returns error.message', () => {
        // The exact shape that defeated toApiErrorResponse.
        const src = codeOnly(read(ROUTE));
        expect(src).not.toMatch(/error instanceof Error \? error\.message/);
        expect(src).not.toMatch(/catch\s*\(\s*error\s*\)/);
    });

    it('still routes through withApiErrorHandling, which shapes errors safely', () => {
        // Removing the catch is only correct because the wrapper is there.
        expect(codeOnly(read(ROUTE))).toMatch(/withApiErrorHandling\(/);
    });
});

describe('register is rate-limited as tenant creation, not as a generic mutation', () => {
    it('declares TENANT_CREATE_LIMIT', () => {
        expect(codeOnly(read(ROUTE))).toMatch(/config:\s*TENANT_CREATE_LIMIT/);
    });

    it('and that preset is meaningfully tighter than the default it replaced', () => {
        // Guards the fix against being satisfied by a preset that was later
        // relaxed to match the default — which would leave the wiring in
        // place and the protection gone.
        const perHour = (c: { maxAttempts: number; windowMs: number }) =>
            c.maxAttempts * (3_600_000 / c.windowMs);
        expect(perHour(TENANT_CREATE_LIMIT)).toBeLessThan(perHour(API_MUTATION_LIMIT) / 10);
    });
});

describe('a self-service tenant has an owner', () => {
    it('the first membership is OWNER, not ADMIN', () => {
        // ADMIN cannot reach admin.tenant_lifecycle or
        // admin.owner_management — both are OWNER-only — so an
        // ADMIN-only tenant can never delete itself, rotate its DEK, or
        // transfer ownership.
        const src = codeOnly(read(ROUTE));
        expect(src).toMatch(/role:\s*'OWNER'/);
        expect(src).not.toMatch(/role:\s*'ADMIN'/);
    });
});
