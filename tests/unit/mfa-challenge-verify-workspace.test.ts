/**
 * The MFA challenge checks a code against the workspace in its URL.
 *
 * It used to check every code against the session's primary workspace, the
 * only one whose policy sign-in ever asked. Now the session's other
 * workspaces can be pending too (src/lib/auth/workspace-mfa.ts). Their
 * challenge pages must verify THAT workspace's enrolment, and must refuse a
 * workspace the person is not an active member of.
 */
const verifyMfaChallenge = jest.fn(async (..._args: unknown[]) => ({ success: true, message: 'ok', remaining: 4 }));
jest.mock('@/app-layer/usecases/mfa-challenge', () => ({
    verifyMfaChallenge: (...args: unknown[]) => verifyMfaChallenge(...args),
}));
jest.mock('@/auth', () => ({
    auth: jest.fn(async () => ({ user: { id: 'user-1', tenantId: 't-alpha', role: 'EDITOR' } })),
}));

const memberships: Record<string, string> = {};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: {
            findUnique: jest.fn(async ({ where }: { where: { slug: string } }) =>
                ({ alpha: { id: 't-alpha' }, beta: { id: 't-beta' }, gamma: { id: 't-gamma' } })[where.slug] ?? null),
        },
        tenantMembership: {
            findUnique: jest.fn(async ({ where }: { where: { tenantId_userId: { tenantId: string } } }) => {
                const status = memberships[where.tenantId_userId.tenantId];
                return status ? { status } : null;
            }),
        },
    },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/t/[tenantSlug]/security/mfa/challenge/verify/route';

async function verifyAt(slug: string) {
    const req = new NextRequest(`http://localhost:3000/api/t/${slug}/security/mfa/challenge/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '123456' }),
    });
    return POST(req, { params: Promise.resolve({ tenantSlug: slug }) });
}

beforeEach(() => {
    verifyMfaChallenge.mockClear();
    for (const k of Object.keys(memberships)) delete memberships[k];
    memberships['t-alpha'] = 'ACTIVE';
    memberships['t-beta'] = 'ACTIVE';
    memberships['t-gamma'] = 'DEACTIVATED';
});

describe("the MFA challenge verifies the URL's workspace", () => {
    it("checks a code at beta's challenge against beta, not the session's primary workspace", async () => {
        const res = await verifyAt('beta');
        expect(res.status).toBe(200);
        expect(verifyMfaChallenge).toHaveBeenCalledWith('user-1', 't-beta', '123456', expect.any(Number));
    });

    it("still checks the primary workspace's code at the primary's challenge", async () => {
        await verifyAt('alpha');
        expect(verifyMfaChallenge).toHaveBeenCalledWith('user-1', 't-alpha', '123456', expect.any(Number));
    });

    it('refuses a workspace the person is not an active member of, and checks no code', async () => {
        expect((await verifyAt('gamma')).status).toBe(400);
        expect((await verifyAt('nowhere')).status).toBe(400);
        expect(verifyMfaChallenge).not.toHaveBeenCalled();
    });
});
