/**
 * /invite/org/[token] (#4853).
 *
 * Renders the REAL server page (session and preview mocked) and drives it:
 *
 *   - Accept redeems with a POST to /api/org/invite/<token>, re-mints the
 *     session's claims BEFORE navigating (the edge org gate reads
 *     `orgMemberships` from the JWT and answered "not found" to a member it
 *     had not seen yet), then goes to /org/<slug>.
 *   - A named refusal is shown in the page's own words, never the server's
 *     English, and keeps the person on the page.
 *   - Nothing from the query string is printed: `?error=` once put any
 *     sentence a link-maker chose beside the organization's name.
 *   - Signed in as somebody else, the page offers a sign-out that comes back
 *     here, never "Sign in to accept": signing in again with the same account
 *     redeems the invitation in the sign-in callback and uses it up.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const pushMock = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: pushMock, replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/invite/org/tok-org',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ token: 'tok-org' }),
}));

jest.mock('next-intl/server', () => {
    const { useTranslations: translatorFor } = jest.requireMock('next-intl') as {
        useTranslations: (ns: string) => unknown;
    };
    return { getTranslations: async (ns: string) => translatorFor(ns) };
});

const authMock = jest.fn();
jest.mock('@/auth', () => ({ auth: (...a: unknown[]) => authMock(...a) }));

const previewMock = jest.fn();
jest.mock('@/app-layer/usecases/org-invites', () => ({
    previewOrgInviteByToken: (...a: unknown[]) => previewMock(...a),
}));

const signOutMock = jest.fn();
jest.mock('next-auth/react', () => ({
    getCsrfToken: jest.fn(async () => 'csrf-1'),
    signOut: (...a: unknown[]) => signOutMock(...a),
}));

import OrgInvitePage from '@/app/invite/org/[token]/page';

type Answer = { status: number; body: unknown };

function stubFetch(redeem: Answer) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u === '/api/org/invite/tok-org' && init?.method === 'POST') {
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

const calls = () => (global.fetch as jest.Mock).mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit | undefined)?.method,
}));

function preview(matchesSession: boolean) {
    return {
        organizationName: 'Acme Group',
        organizationSlug: 'acme-group',
        role: 'ORG_READER',
        expiresAt: new Date('2026-11-08T00:00:00Z'),
        matchesSession,
    };
}

async function renderPage(props: Record<string, unknown> = {}) {
    const ui = await (OrgInvitePage as unknown as (p: unknown) => ReturnType<typeof OrgInvitePage>)({
        params: Promise.resolve({ token: 'tok-org' }),
        ...props,
    });
    render(ui);
}

beforeEach(() => {
    pushMock.mockReset();
    authMock.mockReset();
    previewMock.mockReset();
    signOutMock.mockReset();
});

describe('/invite/org/[token] — accepting as the signed-in invitee', () => {
    beforeEach(() => {
        authMock.mockResolvedValue({ user: { id: 'u-1', email: 'invitee@example.com' } });
        previewMock.mockResolvedValue(preview(true));
    });

    it('redeems, re-mints the session claims, then goes into the organization', async () => {
        stubFetch({ status: 200, body: { organizationId: 'o-1', slug: 'acme-group', role: 'ORG_READER' } });
        await renderPage();
        const accept = screen.getByRole('button', { name: 'Accept invitation' });

        // Not a native form post to a redirecting route.
        expect(accept.closest('form')?.getAttribute('action') ?? null).toBeNull();

        fireEvent.click(accept);

        await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/org/acme-group'));
        expect(calls()).toEqual([
            { url: '/api/org/invite/tok-org', method: 'POST' },
            { url: '/api/auth/session', method: 'POST' },
        ]);
        const fetchMock = global.fetch as jest.Mock;
        expect(fetchMock.mock.invocationCallOrder[1]).toBeLessThan(pushMock.mock.invocationCallOrder[0]);
    });

    it('shows a named refusal in the page\'s own words and stays put', async () => {
        const english = 'Invite has expired';
        stubFetch({
            status: 410,
            body: { error: { code: 'GONE', message: english, details: { reason: 'INVITE_EXPIRED' } } },
        });
        await renderPage();

        fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(
            "This invitation has expired. Ask the organization's admin to send a new invitation.",
        );
        expect(alert).not.toHaveTextContent(english);
        expect(pushMock).not.toHaveBeenCalled();
        expect(calls().map((c) => c.url)).toEqual(['/api/org/invite/tok-org']);
    });

    it('renders nothing from the query string', async () => {
        await renderPage({ searchParams: Promise.resolve({ error: 'Your account is locked. Call +1 555 0100.' }) });

        expect(screen.queryByText(/Call \+1 555 0100/)).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
});

describe('/invite/org/[token] — signed in as a different account', () => {
    beforeEach(() => {
        authMock.mockResolvedValue({ user: { id: 'u-2', email: 'someone-else@example.com' } });
        previewMock.mockResolvedValue(preview(false));
    });

    it('offers a sign-out that returns here, and no sign-in that would use up the invitation', async () => {
        await renderPage();

        expect(screen.queryByRole('link', { name: 'Sign in to accept' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
        expect(screen.getByText(/Signing in again with this account would use up the invitation/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Sign out and use another account' }));

        expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: '/invite/org/tok-org' });
    });
});

describe('/invite/org/[token] — signed out, and not available', () => {
    it('offers sign-in through start-signin when nobody is signed in', async () => {
        authMock.mockResolvedValue(null);
        previewMock.mockResolvedValue(preview(false));
        await renderPage();

        expect(screen.getByRole('link', { name: 'Sign in to accept' })).toHaveAttribute(
            'href',
            '/api/org/invite/tok-org/start-signin',
        );
        expect(screen.queryByRole('button', { name: 'Sign out and use another account' })).not.toBeInTheDocument();
    });

    it('says the invitation is not available, with no emoji', async () => {
        authMock.mockResolvedValue(null);
        previewMock.mockResolvedValue(null);
        await renderPage();

        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Invite not available');
        expect(document.body.textContent ?? '').not.toMatch(/⚠/);
    });
});
