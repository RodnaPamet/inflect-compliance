/* eslint-disable @typescript-eslint/no-explicit-any -- middleware test harness
 * mirrors tests/unit/agent-ownership-transfer-edge-gate.test.ts (NextRequest
 * fixtures + mocked rate-limiters + getToken). */
/**
 * Who can REACH `GET /api/t/:slug/admin/agents/discovered` — the REAL edge
 * middleware's answer, per built-in role (#4472).
 *
 * The runs page offers the discovered-agent picker only to a caller the edge
 * admits to this path (`page.tsx` asks `checkAdminAccess`, the function the
 * middleware applies), so the two must agree: OWNER, ADMIN and AI_ADMIN reach
 * the route; AUDITOR, EDITOR and READER are refused "Admin access required"
 * before it. An AUDITOR holds the inventory key, but this path is not one of
 * its admitted inventory reads — and `discovered` is a listed static segment,
 * so it is not admitted as one agent's row either.
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
import { TENANT_ROLES } from '@/lib/roles';

const mockGetToken = getToken as jest.Mock;

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

const PATH = '/api/t/acme/admin/agents/discovered';

async function reachesRoute(role: string): Promise<boolean> {
    mockGetToken.mockResolvedValue(tokenFor(role));
    const res = await middleware(
        new NextRequest(`http://localhost:3000${PATH}`, {
            method: 'GET',
            headers: new Headers({ 'sec-fetch-site': 'same-origin' }),
        }),
        {} as any,
    );
    const refusedAtEdge =
        res.status === 403 &&
        (await res
            .clone()
            .json()
            .then((b: { error?: string }) => b.error === 'Admin access required')
            .catch(() => false));
    return !refusedAtEdge;
}

beforeEach(() => jest.clearAllMocks());

describe('the edge admits OWNER, ADMIN and AI_ADMIN to the discovered-agent list, and no other built-in role', () => {
    it.each([...TENANT_ROLES])('%s', async (role) => {
        expect({ role, reachesRoute: await reachesRoute(role) }).toEqual({
            role,
            reachesRoute: ['OWNER', 'ADMIN', 'AI_ADMIN'].includes(role),
        });
    });
});
