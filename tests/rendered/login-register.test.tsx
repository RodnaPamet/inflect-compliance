/**
 * Registering and signing in say what went wrong, in the user's language
 * (#4686), and an invitee registers an account without a workspace (#4689).
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
    const cache = new Map<string, unknown>();
    const make = (ns: string) => (key: string) => {
        const v = ns.split('.').concat(key.split('.')).reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
        return typeof v === 'string' ? v : key;
    };
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

import LoginPage from '@/app/login/page';

const en = require('../../messages/en.json');
const L = en.login;

let registerAnswer: { status: number; body: unknown };
const fetchMock = jest.fn(async (url: string) => {
    if (String(url).endsWith('/api/auth/register')) {
        return { ok: registerAnswer.status < 300, status: registerAnswer.status, json: async () => registerAnswer.body };
    }
    return { ok: false, status: 404, json: async () => null };
});

beforeEach(() => {
    mockSignIn.mockReset();
    mockSignIn.mockResolvedValue({ error: 'CredentialsSignin' });
    registerAnswer = { status: 200, body: { user: { id: 'u-1' } } };
    fetchMock.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
});

async function openRegister(query = '') {
    searchParams = new URLSearchParams(query);
    render(<LoginPage />);
    const register = await screen.findByRole('button', { name: L.registerLink });
    fireEvent.click(register);
    return document.getElementById('credentials-form') as HTMLFormElement;
}

function fill(id: string, value: string) {
    fireEvent.change(document.getElementById(id)!, { target: { value } });
}

async function submit(form: HTMLFormElement) {
    await act(async () => {
        fireEvent.submit(form);
    });
}

function registerBody() {
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/auth/register'));
    return JSON.parse((call as unknown as [string, RequestInit])[1].body as string);
}

describe('registering', () => {
    it('shows a named refusal from the catalogue, not the route’s English sentence', async () => {
        registerAnswer = { status: 409, body: { error: 'Email already registered', code: 'EMAIL_ALREADY_REGISTERED' } };
        const form = await openRegister();
        fill('login-name', 'Ana');
        fill('login-org-name', 'Acme');
        fill('login-email', 'ana@example.com');
        fill('login-password', 'long-enough-password');
        await submit(form);

        expect(await screen.findByText(L.refused.EMAIL_ALREADY_REGISTERED)).toBeTruthy();
        expect(screen.queryByText('Email already registered')).toBeNull();
        expect(mockSignIn).not.toHaveBeenCalled();
    });

    it('says when the network has registered too often', async () => {
        registerAnswer = { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } } };
        const form = await openRegister();
        fill('login-name', 'Ana');
        fill('login-org-name', 'Acme');
        fill('login-email', 'ana@example.com');
        fill('login-password', 'long-enough-password');
        await submit(form);
        expect(await screen.findByText(L.tooManyRegistrations)).toBeTruthy();
    });

    it('asks the browser for the policy’s length only while registering', async () => {
        const form = await openRegister();
        const password = document.getElementById('login-password') as HTMLInputElement;
        expect(password.minLength).toBe(8);
        expect(password.maxLength).toBe(128);
        fireEvent.click(screen.getByRole('button', { name: L.signInLink }));
        // Signing in checks no length: an older, shorter password must still get in.
        expect((document.getElementById('login-password') as HTMLInputElement).minLength).toBe(-1);
        void form;
    });
});

describe('registering to accept an invitation', () => {
    it('asks for no organization, says so, and sends none', async () => {
        const form = await openRegister('callbackUrl=/invite/result');
        expect(screen.getByText(L.inviteAccountOnly)).toBeTruthy();
        expect(screen.getByRole('heading', { name: L.registerAccount })).toBeTruthy();
        expect(document.getElementById('login-org-name')).toBeNull();

        fill('login-name', 'Ana');
        fill('login-email', 'ana@example.com');
        fill('login-password', 'long-enough-password');
        await submit(form);

        await waitFor(() => expect(mockSignIn).toHaveBeenCalled());
        expect(registerBody()).toEqual({ action: 'register', email: 'ana@example.com', password: 'long-enough-password', name: 'Ana' });
        expect((mockSignIn.mock.calls[0][1] as { callbackUrl: string }).callbackUrl).toBe('/invite/result');
    });

    it('asks for an organization on an ordinary registration', async () => {
        await openRegister();
        expect(document.getElementById('login-org-name')).toBeTruthy();
        expect(screen.queryByText(L.inviteAccountOnly)).toBeNull();
    });
});

describe('signing in with an unverified email', () => {
    it('says to confirm the email, not that the password is wrong', async () => {
        mockSignIn.mockResolvedValue({ error: 'email_not_verified' });
        searchParams = new URLSearchParams();
        render(<LoginPage />);
        const form = await waitFor(() => {
            const f = document.getElementById('credentials-form');
            if (!f) throw new Error('form not rendered yet');
            return f as HTMLFormElement;
        });
        fill('login-email', 'ana@example.com');
        fill('login-password', 'a-password');
        await submit(form);

        expect(await screen.findByText(L.emailNotVerified)).toBeTruthy();
        expect(screen.queryByText(L.invalidCredentials)).toBeNull();
    });
});
