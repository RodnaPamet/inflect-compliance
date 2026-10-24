/**
 * "Continue with single sign-on" on the sign-in page.
 *
 * Before this, SSO could not be started from the product at all: the sign-in
 * page offered Google, Microsoft and a password, and the only way into a
 * workspace's SSO was a hand-built `/api/auth/sso/<protocol>/start` URL. The
 * person now names their workspace — never their email domain, which any
 * workspace could claim — and is sent to that workspace's provider. The
 * start itself is followed from this page, which is what lets `/start` tell
 * it apart from a sign-in another site tried to begin.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

let searchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({ useSearchParams: () => searchParams }));
jest.mock('next-auth/react', () => ({
    getProviders: jest.fn(async () => ({})),
    signIn: jest.fn(),
}));
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => (key: string, values?: Record<string, string>) => {
        const v = ns.split('.').concat(key.split('.')).reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
        if (typeof v !== 'string') return key;
        return v.replace(/\{(\w+)\}/g, (_m, name: string) => values?.[name] ?? '');
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

import LoginPage from '@/app/login/page';
import { SsoSignIn } from '@/app/login/SsoSignIn';

const en = require('../../messages/en.json');

function answerDiscovery(providers: unknown[] | 'fail') {
    const calls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith('/api/auth/sso/discover')) {
            if (providers === 'fail') return { ok: false, status: 500, json: async () => ({}) } as Response;
            return { ok: true, status: 200, json: async () => ({ providers }) } as Response;
        }
        return { ok: false, status: 404, json: async () => null } as Response;
    }) as unknown as typeof fetch;
    return calls;
}

async function enterWorkspace(name: string) {
    fireEvent.click(screen.getByText(en.login.sso.continue));
    fireEvent.change(document.getElementById('sso-workspace') as HTMLInputElement, { target: { value: name } });
    fireEvent.click(document.getElementById('sso-sign-in-submit') as HTMLElement);
}

beforeEach(() => {
    searchParams = new URLSearchParams();
});

describe('sign-in page — single sign-on entry', () => {
    it('offers single sign-on beside the other ways in', async () => {
        answerDiscovery([]);
        render(<LoginPage />);
        expect(await screen.findByText(en.login.sso.continue)).toBeInTheDocument();
    });

    it('opens on the workspace a shared link names (?sso=)', async () => {
        answerDiscovery([]);
        searchParams = new URLSearchParams('sso=acme');
        render(<LoginPage />);
        expect(await screen.findByDisplayValue('acme')).toBeInTheDocument();
    });
});

describe('SsoSignIn', () => {
    it("goes straight to a workspace's only provider", async () => {
        const calls = answerDiscovery([{ id: 'idp-1', protocol: 'oidc', name: 'Okta' }]);
        const navigate = jest.fn();
        render(<SsoSignIn navigate={navigate} />);
        await enterWorkspace(' Acme ');

        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        expect(calls[0]).toBe('/api/auth/sso/discover?workspace=acme');
        expect(navigate).toHaveBeenCalledWith('/api/auth/sso/oidc/start?tenant=acme&provider=idp-1');
    });

    it('carries the page the person was headed to, when there is one', async () => {
        answerDiscovery([{ id: 'idp-1', protocol: 'saml', name: 'Entra' }]);
        const navigate = jest.fn();
        render(<SsoSignIn navigate={navigate} returnTo="/t/acme/risks" />);
        await enterWorkspace('acme');

        await waitFor(() => expect(navigate).toHaveBeenCalledWith(
            '/api/auth/sso/saml/start?tenant=acme&provider=idp-1&returnTo=%2Ft%2Facme%2Frisks',
        ));
    });

    it('lets the person choose when a workspace offers several', async () => {
        answerDiscovery([
            { id: 'idp-1', protocol: 'oidc', name: 'Okta' },
            { id: 'idp-2', protocol: 'saml', name: 'Entra' },
        ]);
        const navigate = jest.fn();
        render(<SsoSignIn navigate={navigate} />);
        await enterWorkspace('acme');

        fireEvent.click(await screen.findByText('Continue with Entra'));
        expect(navigate).toHaveBeenCalledWith('/api/auth/sso/saml/start?tenant=acme&provider=idp-2');
    });

    it('says so when the workspace has no single sign-on, and goes nowhere', async () => {
        answerDiscovery([]);
        const navigate = jest.fn();
        render(<SsoSignIn navigate={navigate} />);
        await enterWorkspace('plain');

        expect(await screen.findByText(en.login.sso.notAvailable)).toBeInTheDocument();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('says so when the lookup fails', async () => {
        answerDiscovery('fail');
        const navigate = jest.fn();
        render(<SsoSignIn navigate={navigate} />);
        await enterWorkspace('acme');

        expect(await screen.findByText(en.login.sso.failed)).toBeInTheDocument();
        expect(navigate).not.toHaveBeenCalled();
    });
});
