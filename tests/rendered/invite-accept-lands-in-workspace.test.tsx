/**
 * "Accept invitation" lands the invitee in the workspace, not on a page of JSON.
 *
 * For a signed-in invitee, /invite/[token] rendered a plain
 * `<form action="/api/invites/<token>" method="POST">`. That route answers
 * JSON, so the browser navigated to `{"tenantId":…,"slug":…}`. The membership
 * was created, and the user was stranded on raw JSON. The page's comment
 * promised "a thin client form handles the redirect", but there was none.
 *
 * This renders the REAL server page (session and preview mocked) and drives
 * its accept control. It asserts that the control:
 *
 *   - is not a native form submission to the JSON endpoint;
 *   - redeems with a POST to /api/invites/<token>;
 *   - re-mints the session's membership claims (POST /api/auth/session with
 *     the CSRF token) BEFORE navigating, because the Edge tenant-access gate
 *     reads `memberships[]` from the JWT and would otherwise bounce the new
 *     member to /no-tenant;
 *   - navigates to /t/<slug>/dashboard, using the slug the server returned;
 *   - on a refusal, stays on the page, shows the server's reason, and
 *     neither refreshes the session nor navigates.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const pushMock = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: pushMock, replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/invite/tok-abc',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ token: 'tok-abc' }),
}));

// The server page reads its strings through `next-intl/server`; serve them
// from the same English catalogue the root `next-intl` manual mock uses.
jest.mock('next-intl/server', () => {
    // The manual mock's `useTranslations` is a plain factory, not a hook.
    const { useTranslations: translatorFor } = jest.requireMock('next-intl') as {
        useTranslations: (ns: string) => unknown;
    };
    return { getTranslations: async (ns: string) => translatorFor(ns) };
});

const authMock = jest.fn();
jest.mock('@/auth', () => ({ auth: (...a: unknown[]) => authMock(...a) }));

const previewMock = jest.fn();
jest.mock('@/app-layer/usecases/tenant-invites', () => ({
    previewInviteByToken: (...a: unknown[]) => previewMock(...a),
}));

jest.mock('next-auth/react', () => ({ getCsrfToken: jest.fn(async () => 'csrf-1') }));

import InvitePage from '@/app/invite/[token]/page';

type Answer = { status: number; body: unknown };

function stubFetch(redeem: Answer) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u === '/api/invites/tok-abc' && init?.method === 'POST') {
            return {
                ok: redeem.status >= 200 && redeem.status < 300,
                status: redeem.status,
                json: async () => redeem.body,
            } as unknown as Response;
        }
        if (u === '/api/auth/session' && init?.method === 'POST') {
            return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
        }
        throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${u}`);
    }) as unknown as typeof fetch;
}

const calls = () =>
    (global.fetch as jest.Mock).mock.calls.map(([url, init]) => ({
        url: String(url),
        method: (init as RequestInit | undefined)?.method,
        body: (init as RequestInit | undefined)?.body,
    }));

async function renderSignedInInvitee() {
    authMock.mockResolvedValue({ user: { id: 'u-1', email: 'invitee@example.com' } });
    previewMock.mockResolvedValue({
        tenantName: 'Acme',
        tenantSlug: 'acme',
        role: 'EDITOR',
        expiresAt: new Date('2026-11-01T00:00:00Z'),
        matchesSession: true,
    });
    const ui = await InvitePage({
        params: Promise.resolve({ token: 'tok-abc' }),
        searchParams: Promise.resolve({}),
    });
    render(ui);
    return screen.getByRole('button', { name: 'Accept invitation' });
}

beforeEach(() => {
    pushMock.mockReset();
    authMock.mockReset();
    previewMock.mockReset();
});

describe('/invite/[token] — accepting as the signed-in invitee', () => {
    it('redeems, re-mints the session claims, then navigates to the workspace dashboard', async () => {
        stubFetch({ status: 200, body: { tenantId: 't-1', slug: 'acme-workspace', role: 'EDITOR' } });
        const accept = await renderSignedInInvitee();

        // Not a native submission to the JSON endpoint — that is the bug.
        expect(accept.closest('form')?.getAttribute('action') ?? null).not.toBe('/api/invites/tok-abc');

        fireEvent.click(accept);

        await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/t/acme-workspace/dashboard'));
        expect(pushMock).toHaveBeenCalledTimes(1);

        const [redeem, refresh] = calls();
        expect(calls()).toHaveLength(2);
        expect({ url: redeem.url, method: redeem.method }).toEqual({
            url: '/api/invites/tok-abc',
            method: 'POST',
        });
        expect({ url: refresh.url, method: refresh.method }).toEqual({
            url: '/api/auth/session',
            method: 'POST',
        });
        expect(JSON.parse(String(refresh.body))).toEqual({ csrfToken: 'csrf-1', data: {} });

        // The claims are refreshed BEFORE the navigation the Edge gate will judge.
        const fetchMock = global.fetch as jest.Mock;
        expect(fetchMock.mock.invocationCallOrder[1]).toBeLessThan(pushMock.mock.invocationCallOrder[0]);
    });

    it('on a refusal, stays on the page with the server reason and does not navigate', async () => {
        const reason =
            'Invite email does not match signed-in user. Ask your admin to send a new invite to your email address.';
        stubFetch({ status: 403, body: { error: { code: 'FORBIDDEN', message: reason } } });
        const accept = await renderSignedInInvitee();

        fireEvent.click(accept);

        expect(await screen.findByRole('alert')).toHaveTextContent(reason);
        expect(pushMock).not.toHaveBeenCalled();
        expect(calls().map((c) => c.url)).toEqual(['/api/invites/tok-abc']);
        // The control is usable again, so the user can retry or switch account.
        expect(screen.getByRole('button', { name: 'Accept invitation' })).not.toBeDisabled();
    });
});
