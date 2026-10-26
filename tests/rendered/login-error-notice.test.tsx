/**
 * The sign-in page explains a failed sign-in, and only in its own words.
 *
 * A failed SSO callback — and NextAuth itself — sends the browser to
 * `/login?error=<code>`, the SSO callbacks with an `error_description` beside
 * it. The page used to ignore both, so an SSO sign-in that failed for a
 * reason the person could act on ("ask your administrator to add you") looked
 * exactly like a page that had merely reloaded. It now shows a fixed message
 * per code, and never the description: anyone can write a link to `/login`
 * carrying whatever text they like.
 */
import { render, screen, waitFor } from '@testing-library/react';

let searchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({ useSearchParams: () => searchParams }));
jest.mock('next-auth/react', () => ({
    getProviders: jest.fn(async () => ({})),
    signIn: jest.fn(),
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

const en = require('../../messages/en.json');

beforeEach(() => {
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => null })) as unknown as typeof fetch;
});

async function renderWith(query: string) {
    searchParams = new URLSearchParams(query);
    render(<LoginPage />);
    // Let the provider lookup settle.
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
}

describe('sign-in page — ?error=', () => {
    it('explains an SSO sign-in with no account in the workspace, without echoing the link’s text', async () => {
        await renderWith('error=no_membership&error_description=Call+0800+123+456+to+restore+access');
        expect(document.getElementById('login-error-notice')).toHaveTextContent(en.login.errors.ssoNoAccount);
        expect(screen.queryByText(/0800/)).toBeNull();
        expect(screen.queryByText('no_membership')).toBeNull();
    });

    it.each([
        ['domain_mismatch', en.login.errors.ssoDomainNotAllowed],
        ['provider_disabled', en.login.errors.ssoUnavailable],
        ['nonce_mismatch', en.login.errors.ssoIncomplete],
        ['id_token_invalid', en.login.errors.ssoIncomplete],
        ['OAuthAccountNotLinked', en.login.errors.accountNotLinked],
    ])('%s reads as its own message', async (code, message) => {
        await renderWith(`error=${code}`);
        expect(document.getElementById('login-error-notice')).toHaveTextContent(message);
    });

    it('reads a code nobody listed as the generic message, never as the code', async () => {
        await renderWith('error=%3Cb%3Ehello%3C%2Fb%3E');
        expect(document.getElementById('login-error-notice')).toHaveTextContent(en.login.errors.signInFailed);
        expect(screen.queryByText(/hello/)).toBeNull();
    });

    it('shows nothing without an error', async () => {
        await renderWith('');
        expect(document.getElementById('login-error-notice')).toBeNull();
    });
});
