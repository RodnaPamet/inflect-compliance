/**
 * The two tenant invite-creation routes email the invite, and say whether
 * they did.
 *
 * The members page's "Invite Member" form POSTs to `/admin/members` and then
 * told the admin "We also emailed them an invite link." That route created
 * the invite and sent nothing: only `/admin/invites`, which no screen calls,
 * emailed the link. Both routes now share one implementation, so each one:
 *
 *   - hands the acceptance link to the mailer, addressed to the invitee;
 *   - answers `emailSent: true` only when a configured transport took it;
 *   - answers `emailSent: false` when no mailer is configured — a
 *     self-hosted deployment without SMTP, where the console sink logs the
 *     message and delivers it to nobody — and still returns the link;
 *   - charges the same per-tenant invite budget, since each one sends mail.
 *
 * The mailer and `sendInviteEmail` are REAL here; only the transport is
 * swapped, so "emailSent" is asserted against what reached the transport.
 */
import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

const createInviteTokenMock = jest.fn();
jest.mock('@/app-layer/usecases/tenant-invites', () => ({
    createInviteToken: (...a: unknown[]) => createInviteTokenMock(...a),
    listPendingInvites: jest.fn(),
}));

jest.mock('@/app-layer/usecases/tenant-admin', () => ({
    listTenantMembers: jest.fn(),
}));

import { POST as membersPOST } from '@/app/api/t/[tenantSlug]/admin/members/route';
import { POST as invitesPOST } from '@/app/api/t/[tenantSlug]/admin/invites/route';
import { ConsoleEmailProvider, StubEmailProvider, setEmailProvider } from '@/lib/mailer';
import { clearAllRateLimits } from '@/lib/security/rate-limit';
import { makeRequestContext } from '../helpers/make-context';

type RoutePost = (req: NextRequest, args: { params: Promise<{ tenantSlug: string }> }) => Promise<Response>;

const ROUTES: ReadonlyArray<[string, RoutePost]> = [
    ['POST /admin/members (the members page)', membersPOST as unknown as RoutePost],
    ['POST /admin/invites', invitesPOST as unknown as RoutePost],
];

const routeArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) };

function post(path: string, body: unknown): NextRequest {
    return new NextRequest(`https://app.example.io/api/t/acme/admin/${path}`, {
        method: 'POST',
        headers: new Headers({
            'content-type': 'application/json',
            'x-forwarded-host': 'app.example.io',
            'x-forwarded-proto': 'https',
        }),
        body: JSON.stringify(body),
    });
}

const call = (route: RoutePost, path: string) =>
    route(post(path, { email: 'new.person@example.com', role: 'EDITOR' }), routeArgs);

const pathOf = (label: string) => (label.includes('/admin/members') ? 'members' : 'invites');

const ORIGINAL_SMTP_HOST = process.env.SMTP_HOST;

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getTenantCtxMock.mockResolvedValue(makeRequestContext('ADMIN', { tenantSlug: 'acme' }));
    createInviteTokenMock.mockReset();
    createInviteTokenMock.mockResolvedValue({
        invite: {
            id: 'inv-1',
            email: 'new.person@example.com',
            role: 'EDITOR',
            token: 'tok-abc',
            expiresAt: new Date(Date.now() + 7 * 86_400_000),
            createdAt: new Date(),
        },
        url: '/invite/tok-abc',
    });
    delete process.env.SMTP_HOST;
});

afterAll(() => {
    if (ORIGINAL_SMTP_HOST !== undefined) process.env.SMTP_HOST = ORIGINAL_SMTP_HOST;
    setEmailProvider(new ConsoleEmailProvider());
});

describe.each(ROUTES)('%s', (label, route) => {
    const path = pathOf(label);

    it('emails the acceptance link to the invitee and answers emailSent: true', async () => {
        const transport = new StubEmailProvider();
        setEmailProvider(transport);

        const res = await call(route, path);

        expect(res.status).toBe(201);
        const body = await res.json();
        expect({ emailSent: body.emailSent, url: body.url }).toEqual({
            emailSent: true,
            url: '/invite/tok-abc',
        });
        expect(transport.sentMessages).toHaveLength(1);
        const [msg] = transport.sentMessages;
        expect(msg.to).toBe('new.person@example.com');
        expect(msg.text).toContain('https://app.example.io/invite/tok-abc');
        expect(createInviteTokenMock).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: expect.any(String) }),
            { email: 'new.person@example.com', role: 'EDITOR' },
        );
    });

    it('answers emailSent: false when no mailer is configured, and still returns the link', async () => {
        // A self-hosted deployment with no SMTP_HOST: the console sink.
        setEmailProvider(new ConsoleEmailProvider());

        const res = await call(route, path);

        expect(res.status).toBe(201);
        const body = await res.json();
        expect({ emailSent: body.emailSent, url: body.url }).toEqual({
            emailSent: false,
            url: '/invite/tok-abc',
        });
    });

    it('answers emailSent: false when the transport refuses, and still returns the link', async () => {
        setEmailProvider({
            send: async () => {
                throw new Error('SMTP 421 service not available');
            },
        });

        const res = await call(route, path);

        expect(res.status).toBe(201);
        const body = await res.json();
        expect({ emailSent: body.emailSent, url: body.url }).toEqual({
            emailSent: false,
            url: '/invite/tok-abc',
        });
    });
});

describe('the per-tenant invite budget', () => {
    const ORIGINAL_RATE_LIMIT = process.env.RATE_LIMIT_ENABLED;

    beforeEach(() => {
        process.env.RATE_LIMIT_ENABLED = '1';
        clearAllRateLimits();
        setEmailProvider(new StubEmailProvider());
    });

    afterEach(() => {
        if (ORIGINAL_RATE_LIMIT === undefined) delete process.env.RATE_LIMIT_ENABLED;
        else process.env.RATE_LIMIT_ENABLED = ORIGINAL_RATE_LIMIT;
        clearAllRateLimits();
    });

    it('is shared by both routes: the members page cannot send past the limit the invites route enforces', async () => {
        for (let i = 0; i < 20; i++) {
            expect((await call(membersPOST as unknown as RoutePost, 'members')).status).toBe(201);
        }
        expect((await call(invitesPOST as unknown as RoutePost, 'invites')).status).toBe(429);
        expect((await call(membersPOST as unknown as RoutePost, 'members')).status).toBe(429);
        expect(createInviteTokenMock).toHaveBeenCalledTimes(20);
    });
});
