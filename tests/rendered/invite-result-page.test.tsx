/**
 * /invite/result — what a person sees after "Sign in to accept" (#4689).
 *
 * The sign-in callback redeems the invite cookie and can only log a refusal,
 * so before this page a person whose invite was refused (an email mismatch
 * burns it) landed on the workspace picker with no word about it.
 */
import { render, screen } from '@testing-library/react';

class RedirectSignal extends Error {
    constructor(readonly to: string) {
        super(`NEXT_REDIRECT ${to}`);
    }
}
jest.mock('next/navigation', () => ({
    redirect: (to: string) => {
        throw new RedirectSignal(to);
    },
}));

jest.mock('next-intl/server', () => {
    const { useTranslations: translatorFor } = jest.requireMock('next-intl') as {
        useTranslations: (ns: string) => unknown;
    };
    return { getTranslations: async (ns: string) => translatorFor(ns) };
});

const cookieValue = { current: undefined as string | undefined };
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) =>
            name === 'inflect_invite_token' && cookieValue.current ? { value: cookieValue.current } : undefined,
    }),
}));

const authMock = jest.fn();
jest.mock('@/auth', () => ({ auth: (...a: unknown[]) => authMock(...a) }));

const outcomeMock = jest.fn();
jest.mock('@/app-layer/usecases/tenant-invites', () => ({
    inviteSignInOutcome: (...a: unknown[]) => outcomeMock(...a),
}));

import InviteResultPage from '@/app/invite/result/page';

async function redirectOf(): Promise<string> {
    try {
        await InviteResultPage();
    } catch (e) {
        if (e instanceof RedirectSignal) return e.to;
        throw e;
    }
    throw new Error('expected a redirect');
}

beforeEach(() => {
    authMock.mockReset();
    outcomeMock.mockReset();
    cookieValue.current = 'tok-abc';
    authMock.mockResolvedValue({ user: { id: 'u-1', email: 'someone@example.com' } });
});

describe('/invite/result', () => {
    it('says why the invite was refused, in the person’s language', async () => {
        outcomeMock.mockResolvedValue({ kind: 'REFUSED', reason: 'INVITE_EMAIL_MISMATCH', tenantName: 'Acme' });

        render(await InviteResultPage());

        expect(screen.getByRole('heading', { name: 'Invitation not accepted' })).toBeInTheDocument();
        expect(
            screen.getByText(/sent to a different email address from the account you signed in with/),
        ).toBeInTheDocument();
        // The test catalogue's `.rich` leaves arguments unfilled; the line is there.
        expect(screen.getByText(/You are signed in as/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Go to your workspaces' })).toHaveAttribute('href', '/tenants');
        expect(outcomeMock).toHaveBeenCalledWith({
            token: 'tok-abc',
            userId: 'u-1',
            userEmail: 'someone@example.com',
        });
    });

    it('goes straight into the workspace when the invite was accepted', async () => {
        outcomeMock.mockResolvedValue({ kind: 'ACCEPTED', slug: 'acme' });
        await expect(redirectOf()).resolves.toBe('/t/acme/dashboard');
    });

    it('goes back to the invite when it is still live', async () => {
        outcomeMock.mockResolvedValue({ kind: 'PENDING' });
        await expect(redirectOf()).resolves.toBe('/invite/tok-abc');
    });

    it('sends a person with no invite cookie to their workspaces, reading nothing', async () => {
        cookieValue.current = undefined;
        await expect(redirectOf()).resolves.toBe('/tenants');
        expect(outcomeMock).not.toHaveBeenCalled();
    });

    it('sends a signed-out visitor to sign in, reading nothing', async () => {
        authMock.mockResolvedValue(null);
        await expect(redirectOf()).resolves.toBe('/login');
        expect(outcomeMock).not.toHaveBeenCalled();
    });
});
