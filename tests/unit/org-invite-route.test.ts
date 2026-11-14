/**
 * Epic D — org invite route contract.
 *
 * Mocks org-context + the usecase so we exercise:
 *   - 403 when caller lacks canManageMembers (ORG_READER)
 *   - 201 + url for ORG_ADMIN POST
 *   - 200 + invites array for GET pending
 *   - 410 anti-enumeration on accept GET when preview is null
 *   - 200 + slug on accept POST when redeem succeeds
 */
import { NextRequest } from 'next/server';

const getOrgCtxMock = jest.fn();
const createOrgInviteTokenMock = jest.fn();
const listPendingOrgInvitesMock = jest.fn();
const previewOrgInviteByTokenMock = jest.fn();
const redeemOrgInviteMock = jest.fn();
const authMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getOrgCtx: (...a: unknown[]) => getOrgCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/org-invites', () => ({
    __esModule: true,
    createOrgInviteToken: (...a: unknown[]) => createOrgInviteTokenMock(...a),
    listPendingOrgInvites: (...a: unknown[]) => listPendingOrgInvitesMock(...a),
    previewOrgInviteByToken: (...a: unknown[]) => previewOrgInviteByTokenMock(...a),
    redeemOrgInvite: (...a: unknown[]) => redeemOrgInviteMock(...a),
}));

jest.mock('@/auth', () => ({
    __esModule: true,
    auth: (...a: unknown[]) => authMock(...a),
    authOptions: {},
    signOut: jest.fn(),
}));

import { POST as createPost, GET as listGet } from '@/app/api/org/[orgSlug]/invites/route';
import { GET as acceptGet, POST as acceptPost } from '@/app/api/org/invite/[token]/route';
import { ConsoleEmailProvider, StubEmailProvider, setEmailProvider } from '@/lib/mailer';

function ctxFor(canManageMembers: boolean) {
    return {
        requestId: 'req-test',
        userId: 'caller-1',
        organizationId: 'org-1',
        orgSlug: 'acme-org',
        orgRole: canManageMembers ? 'ORG_ADMIN' : 'ORG_READER',
        permissions: {
            canViewPortfolio: true,
            canDrillDown: canManageMembers,
            canExportReports: true,
            canManageTenants: canManageMembers,
            canManageMembers,
        },
    };
}

beforeEach(() => {
    getOrgCtxMock.mockReset();
    createOrgInviteTokenMock.mockReset();
    listPendingOrgInvitesMock.mockReset();
    previewOrgInviteByTokenMock.mockReset();
    redeemOrgInviteMock.mockReset();
    authMock.mockReset();
});

describe('POST /api/org/[orgSlug]/invites', () => {
    function makeReq(body: unknown): NextRequest {
        return new NextRequest('http://localhost/api/org/acme-org/invites', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('returns 201 + invite + url for ORG_ADMIN', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(true));
        createOrgInviteTokenMock.mockResolvedValue({
            invite: {
                id: 'inv-1',
                email: 'a@b.com',
                role: 'ORG_READER',
                expiresAt: new Date(Date.now() + 86400000),
                createdAt: new Date(),
            },
            url: '/invite/org/abc',
        });

        const res = await createPost(
            makeReq({ email: 'a@b.com', role: 'ORG_READER' }),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.invite.email).toBe('a@b.com');
        expect(body.url).toBe('/invite/org/abc');
    });

    it('builds the emailed link on APP_URL, never on a spoofed X-Forwarded-Host', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(true));
        createOrgInviteTokenMock.mockResolvedValue({
            invite: {
                id: 'inv-1',
                email: 'a@b.com',
                role: 'ORG_READER',
                expiresAt: new Date(Date.now() + 86400000),
                createdAt: new Date(),
            },
            url: '/invite/org/abc',
        });
        const transport = new StubEmailProvider();
        setEmailProvider(transport);
        const original = process.env.APP_URL;
        process.env.APP_URL = 'https://inflect.example.io';
        try {
            const req = new NextRequest('http://localhost/api/org/acme-org/invites', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-forwarded-host': 'evil.example',
                },
                body: JSON.stringify({ email: 'a@b.com', role: 'ORG_READER' }),
            });
            const res = await createPost(req, { params: Promise.resolve({ orgSlug: 'acme-org' }) });
            expect(res.status).toBe(201);
        } finally {
            if (original === undefined) delete process.env.APP_URL;
            else process.env.APP_URL = original;
            setEmailProvider(new ConsoleEmailProvider());
        }
        const [msg] = transport.sentMessages;
        expect(msg.text).toContain('https://inflect.example.io/invite/org/abc');
        expect(msg.text).not.toContain('evil.example');
    });

    it('returns 403 when caller lacks canManageMembers', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(false));

        const res = await createPost(
            makeReq({ email: 'a@b.com', role: 'ORG_READER' }),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(403);
        expect(createOrgInviteTokenMock).not.toHaveBeenCalled();
    });
});

describe('GET /api/org/[orgSlug]/invites', () => {
    it('returns 200 + invites array for ORG_ADMIN', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(true));
        listPendingOrgInvitesMock.mockResolvedValue([
            {
                id: 'inv-1',
                email: 'a@b.com',
                role: 'ORG_READER',
                expiresAt: new Date(),
                createdAt: new Date(),
                invitedBy: { id: 'u-1', name: 'Inviter', email: 'i@b.com' },
            },
        ]);

        const req = new NextRequest('http://localhost/api/org/acme-org/invites');
        const res = await listGet(req, { params: Promise.resolve({ orgSlug: 'acme-org' }) });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.invites).toHaveLength(1);
        expect(body.invites[0].email).toBe('a@b.com');
    });

    it('returns 403 for ORG_READER', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(false));
        const req = new NextRequest('http://localhost/api/org/acme-org/invites');
        const res = await listGet(req, { params: Promise.resolve({ orgSlug: 'acme-org' }) });
        expect(res.status).toBe(403);
    });
});

describe('GET /api/org/invite/[token] — anti-enumeration', () => {
    it('returns 410 when preview is null (collapses every "not redeemable" state)', async () => {
        authMock.mockResolvedValue({ user: { email: 'caller@x.com' } });
        previewOrgInviteByTokenMock.mockResolvedValue(null);

        const req = new NextRequest('http://localhost/api/org/invite/abc');
        const res = await acceptGet(req, {
            params: Promise.resolve({ token: 'abc' }),
        });
        expect(res.status).toBe(410);
    });

    it('returns 200 + preview when valid', async () => {
        authMock.mockResolvedValue({ user: { email: 'caller@x.com' } });
        previewOrgInviteByTokenMock.mockResolvedValue({
            organizationName: 'Org X',
            organizationSlug: 'org-x',
            role: 'ORG_READER',
            expiresAt: new Date(Date.now() + 86400000),
            matchesSession: true,
        });

        const req = new NextRequest('http://localhost/api/org/invite/abc');
        const res = await acceptGet(req, {
            params: Promise.resolve({ token: 'abc' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.organizationSlug).toBe('org-x');
        expect(body.matchesSession).toBe(true);
    });
});

describe('POST /api/org/invite/[token] — redeem', () => {
    it('returns 200 + slug on success', async () => {
        authMock.mockResolvedValue({
            user: { id: 'u-1', email: 'invitee@x.com' },
        });
        redeemOrgInviteMock.mockResolvedValue({
            organizationId: 'org-x',
            organizationSlug: 'org-x',
            role: 'ORG_ADMIN',
            provision: { created: 2, skipped: 0, totalConsidered: 2, tenantIds: ['t-1', 't-2'] },
        });

        const req = new NextRequest('http://localhost/api/org/invite/abc', { method: 'POST' });
        const res = await acceptPost(req, {
            params: Promise.resolve({ token: 'abc' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.slug).toBe('org-x');
        expect(body.role).toBe('ORG_ADMIN');
        expect(body.provisioned.created).toBe(2);
    });

    it('returns 401 when not signed in', async () => {
        authMock.mockResolvedValue(null);
        const req = new NextRequest('http://localhost/api/org/invite/abc', { method: 'POST' });
        const res = await acceptPost(req, {
            params: Promise.resolve({ token: 'abc' }),
        });
        expect(res.status).toBe(401);
        expect(redeemOrgInviteMock).not.toHaveBeenCalled();
    });
});
