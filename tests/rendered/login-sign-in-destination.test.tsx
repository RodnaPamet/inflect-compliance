/**
 * Where the sign-in page sends someone once they have signed in.
 *
 * The page read `?callbackUrl=` and, after a password sign-in, assigned it to
 * `window.location.href` unchecked: any link to `/login` could choose where a
 * person landed after typing their password, including another site or a
 * `javascript:` URL running on this origin. It also never read `?next=`, which
 * is what the middleware sets when it bounces a signed-out visitor here, so a
 * deep link from an email always ended on the workspace picker.
 *
 * The page hands the same destination to `signIn` and to the redirect after
 * it, so the destination `signIn` receives is the one the browser goes to.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

let searchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({ useSearchParams: () => searchParams }));
const mockSignIn = jest.fn();
jest.mock('next-auth/react', () => ({
    getProviders: jest.fn(async () => ({ credentials: { id: 'credentials' } })),
    signIn: (...args: unknown[]) => mockSignIn(...args),
}));
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => (key: string) => {
        const v = ns.split('.').concat(key.split('.')).reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
        return typeof v === 'string' ? v : key;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

import LoginPage from '@/app/login/page';
import { postSignInPath } from '@/lib/auth/redirect-path';

const en = require('../../messages/en.json');

beforeEach(() => {
    mockSignIn.mockReset();
    // A failed password sign-in keeps the page where it is: what is asserted
    // is the destination `signIn` was given, not a navigation jsdom cannot do.
    mockSignIn.mockResolvedValue({ error: 'CredentialsSignin' });
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => null })) as unknown as typeof fetch;
});

async function signInWithPassword(query: string) {
    searchParams = new URLSearchParams(query);
    render(<LoginPage />);
    const form = await waitFor(() => {
        const f = document.getElementById('credentials-form');
        if (!f) throw new Error('form not rendered yet');
        return f;
    });
    fireEvent.change(form.querySelector('input[type="email"]')!, { target: { value: 'ada@example.com' } });
    fireEvent.change(form.querySelector('input[type="password"]')!, { target: { value: 'a-password' } });
    await act(async () => {
        fireEvent.submit(form);
    });
    expect(mockSignIn).toHaveBeenCalledWith('credentials', expect.anything());
    return (mockSignIn.mock.calls[0][1] as { callbackUrl: string }).callbackUrl;
}

describe('the sign-in page only ever sends a person to a page of this site', () => {
    it.each([
        ['callbackUrl=https://evil.example/steal'],
        ['callbackUrl=//evil.example'],
        ['callbackUrl=javascript:alert(document.cookie)'],
        ['callbackUrl=/%5Cevil.example'],
        ['next=https://evil.example'],
    ])('%s goes to the workspace picker', async (query) => {
        expect(await signInWithPassword(query)).toBe('/tenants');
    });

    it('keeps a destination on this site', async () => {
        expect(await signInWithPassword('callbackUrl=/t/acme/risks/r-1')).toBe('/t/acme/risks/r-1');
    });

    it('follows the middleware’s ?next=, so a deep link survives signing in', async () => {
        expect(await signInWithPassword('next=/t/acme/risks?status=OPEN')).toBe('/t/acme/risks?status=OPEN');
    });

    it('goes to the workspace picker when the page was opened with no destination', async () => {
        expect(await signInWithPassword('')).toBe('/tenants');
    });

    it('gives Google the same checked destination', async () => {
        searchParams = new URLSearchParams('callbackUrl=https://evil.example');
        render(<LoginPage />);
        await act(async () => {
            fireEvent.click(screen.getByText(en.login.continueWithGoogle));
        });
        expect(mockSignIn).toHaveBeenCalledWith('google', { callbackUrl: '/tenants' });
    });
});

describe('postSignInPath', () => {
    it('is the workspace picker for nothing usable', () => {
        expect(postSignInPath(undefined)).toBe('/tenants');
        expect(postSignInPath(null)).toBe('/tenants');
        expect(postSignInPath('/')).toBe('/tenants');
        expect(postSignInPath('https://evil.example')).toBe('/tenants');
    });
});
