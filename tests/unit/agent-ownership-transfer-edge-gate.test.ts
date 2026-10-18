/* eslint-disable @typescript-eslint/no-explicit-any -- middleware test harness
 * mirrors tests/integration/middleware-mfa-gate.test.ts (NextRequest fixtures +
 * mocked rate-limiters + getToken). */
/**
 * Who can REACH the ownership-transfer routes — the edge's answer, not ours (#3698).
 *
 * Step one refuses a recipient who could never complete step two, so it has to
 * predict every gate step two meets. Two of them: the route's literal
 * `requirePermission('admin.agent_ownership')` (#3699), and BEFORE it the edge
 * middleware's admin-path gate, which reads the session's BUILT-IN role in the
 * URL's tenant and answers 403 "Admin access required" unless it is ADMIN or
 * OWNER — or AI_ADMIN, on the agent paths these routes sit under. A custom
 * role never enters that check, so a READER whose custom role carries the key
 * passes `requirePermission` and never reaches it.
 *
 * `TRANSFER_RECIPIENT_MEMBERSHIP_ROLES` is step one's copy of that set. This
 * suite runs the REAL middleware against both transfer routes for every
 * built-in role and asserts that the edge admits exactly the roles step one
 * accepts. Widen the edge, narrow it, or edit the set, and one side here
 * disagrees with the other.
 */
import { NextRequest } from 'next/server';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
    isApiReadRateLimited: jest.fn().mockReturnValue(false),
    extractTenantSlug: jest.fn().mockReturnValue(null),
}));
jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));

import middleware from '../../src/middleware';
import { getToken } from 'next-auth/jwt';
import {
    isTransferRecipientMembershipRole,
    TRANSFER_RECIPIENT_MEMBERSHIP_ROLES,
} from '@/lib/agentic/ownership-transfer';
import { TENANT_ROLES } from '@/lib/roles';

const mockGetToken = getToken as jest.Mock;

/** A signed-in member of `acme` whose (primary) built-in role is `role`. */
function tokenFor(role: string) {
    return {
        sub: 'user-1',
        userId: 'user-1',
        role,
        mfaPending: false,
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        memberships: [{ slug: 'acme', role, tenantId: 'tenant-1' }],
        orgMemberships: [],
    };
}

function req(method: string, pathname: string) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method,
        // A same-origin browser request, so the admin path's cross-site check
        // is not what answers.
        headers: new Headers({ 'sec-fetch-site': 'same-origin' }),
    });
}

const AGENT = '/api/t/acme/admin/agents/agent-1';
const ROUTES: Array<[string, string]> = [
    ['POST', `${AGENT}/ownership-transfer/complete`],
    ['POST', `${AGENT}/ownership-transfer`],
];

beforeEach(() => jest.clearAllMocks());

describe('the edge admits exactly the built-in roles step one accepts as a recipient', () => {
    // `TENANT_ROLES`, not `Object.values(Role)`: it is checked against the
    // `Role` TYPE at compile time, so it cannot lag a runtime client generated
    // before AI_ADMIN existed.
    const roles: readonly string[] = TENANT_ROLES;

    it('covers every built-in role, and the set names only real ones', () => {
        expect(roles.length).toBeGreaterThan(TRANSFER_RECIPIENT_MEMBERSHIP_ROLES.length);
        for (const r of TRANSFER_RECIPIENT_MEMBERSHIP_ROLES) expect(roles).toContain(r);
    });

    it.each(roles.flatMap((role) => ROUTES.map(([method, path]) => [role, method, path] as const)))(
        '%s → %s %s',
        async (role, method, path) => {
            mockGetToken.mockResolvedValue(tokenFor(role));
            const res = await middleware(req(method, path), {} as any);
            const refusedAtEdge =
                res.status === 403 &&
                (await res
                    .clone()
                    .json()
                    .then((b: { error?: string }) => b.error === 'Admin access required')
                    .catch(() => false));
            expect({ role, reachesRoute: !refusedAtEdge }).toEqual({
                role,
                reachesRoute: isTransferRecipientMembershipRole(role),
            });
        },
    );
});
