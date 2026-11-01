/**
 * #4868 — minting and revoking a SCIM token are audited, and a refused revoke
 * is a refusal.
 *
 * A SCIM token lets whoever holds it create and deactivate members, so who
 * issued one and who took one away belongs in the workspace's audit log, as it
 * does for an API key. Neither row may carry the token or its hash.
 */
const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));

const mockLogEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

const db = {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
};
jest.mock('@/lib/prisma', () => {
    const client = {
        tenantScimToken: {
            create: (...a: unknown[]) => db.create(...a),
            findFirst: (...a: unknown[]) => db.findFirst(...a),
            update: (...a: unknown[]) => db.update(...a),
        },
    };
    return { __esModule: true, default: client, prisma: client };
});

import { POST, DELETE } from '@/app/api/t/[tenantSlug]/admin/scim/route';
import { makeRequestContext } from '../helpers/make-context';

function req(method: string, body: unknown) {
    return {
        method,
        url: 'https://app.example.com/api/t/acme/admin/scim',
        headers: new Headers({ 'content-type': 'application/json' }),
        nextUrl: {
            pathname: '/api/t/acme/admin/scim',
            protocol: 'https:',
            host: 'app.example.com',
            searchParams: new URLSearchParams(),
        },
        json: async () => body,
    } as unknown as import('next/server').NextRequest;
}

const routeArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) };

beforeEach(() => {
    jest.clearAllMocks();
    mockGetTenantCtx.mockResolvedValue(makeRequestContext('ADMIN', { tenantId: 't1', tenantSlug: 'acme' }));
});

describe('minting a SCIM token', () => {
    it('writes SCIM_TOKEN_CREATED naming the label, and never the token', async () => {
        db.create.mockResolvedValue({ id: 'tok-1', label: 'Okta SCIM', createdAt: new Date() });

        const res = await POST(req('POST', { label: 'Okta SCIM' }), routeArgs as never);
        const body = (await res.json()) as { plaintext: string };

        expect(res.status).toBe(201);
        expect(mockLogEvent).toHaveBeenCalledTimes(1);
        const [, , payload] = mockLogEvent.mock.calls[0];
        expect(payload).toMatchObject({
            action: 'SCIM_TOKEN_CREATED',
            entityType: 'TenantScimToken',
            entityId: 'tok-1',
        });
        const written = JSON.stringify(payload);
        expect(written).toContain('Okta SCIM');
        expect(written).not.toContain(body.plaintext);
        expect(JSON.stringify(db.create.mock.calls[0][0])).not.toContain(body.plaintext);
    });

    it('refuses a label that is not a string', async () => {
        const res = await POST(req('POST', { label: 42 }), routeArgs as never);
        expect(res.status).toBe(400);
        expect(db.create).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });
});

describe('revoking a SCIM token', () => {
    it('writes SCIM_TOKEN_REVOKED', async () => {
        db.findFirst.mockResolvedValue({ id: 'tok-1', label: 'Okta SCIM', revokedAt: null, tokenHash: 'h' });
        db.update.mockResolvedValue({});

        const res = await DELETE(req('DELETE', { tokenId: 'tok-1' }), routeArgs as never);

        expect(res.status).toBe(200);
        expect(mockLogEvent).toHaveBeenCalledTimes(1);
        expect(mockLogEvent.mock.calls[0][2]).toMatchObject({
            action: 'SCIM_TOKEN_REVOKED',
            entityId: 'tok-1',
        });
        expect(JSON.stringify(mockLogEvent.mock.calls[0][2])).not.toContain('"h"');
    });

    it("answers 404 with a sentence for another workspace's token, and audits nothing", async () => {
        db.findFirst.mockResolvedValue(null);

        const res = await DELETE(req('DELETE', { tokenId: 'tok-x' }), routeArgs as never);
        const body = (await res.json()) as { error: { message: string } };

        expect(res.status).toBe(404);
        expect(body.error.message).toBe('This token no longer exists in this workspace.');
        expect(db.update).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('revoking an already-revoked token writes nothing again', async () => {
        db.findFirst.mockResolvedValue({ id: 'tok-1', label: 'Okta SCIM', revokedAt: new Date('2026-10-01T00:00:00Z') });

        const res = await DELETE(req('DELETE', { tokenId: 'tok-1' }), routeArgs as never);

        expect(res.status).toBe(200);
        expect(db.update).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });
});
