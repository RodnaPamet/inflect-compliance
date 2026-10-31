/** @jest-environment jsdom */

/**
 * #4645 — the account security page says a refusal from its own catalogue,
 * and does not offer a password change to an account with no password.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

const en = jest.requireActual('../../messages/en.json');
const S = en.account.security;

const lookup = (ns: string, key: string) =>
    `${ns}.${key}`.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        jest.requireActual('../../messages/en.json'),
    );
jest.mock('next-intl/server', () => ({
    getTranslations: async (ns: string) => (key: string) => lookup(ns, key) ?? key,
}));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
const mockHasPassword = jest.fn();
jest.mock('@/lib/auth/password-management', () => ({
    accountHasPassword: (id: string) => mockHasPassword(id),
}));
jest.mock('next/navigation', () => ({ redirect: jest.fn() }));

import { ChangePasswordForm } from '@/app/account/security/ChangePasswordForm';
import AccountSecurityPage from '@/app/account/security/page';

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

async function submit() {
    render(<ChangePasswordForm />);
    const [current, next, confirm] = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    fireEvent.change(current, { target: { value: 'old-password' } });
    fireEvent.change(next, { target: { value: 'new-password-1' } });
    fireEvent.change(confirm, { target: { value: 'new-password-1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: S.changePassword })); });
}

describe('the change-password form (#4645)', () => {
    it("says a known refusal from the catalogue, not the server's English", async () => {
        fetchMock.mockResolvedValue({
            ok: false, status: 400,
            json: async () => ({ error: 'SERVER SENTENCE', code: 'CURRENT_PASSWORD_INCORRECT' }),
        });
        await submit();
        expect(await screen.findByText(S.currentIncorrect)).toBeTruthy();
        expect(screen.queryByText('SERVER SENTENCE')).toBeNull();
    });

    it('says a breached password from the catalogue', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'x', code: 'PASSWORD_BREACHED' }) });
        await submit();
        expect(await screen.findByText(S.breached)).toBeTruthy();
    });

    it("falls back to the server's message for a refusal with no known code", async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }) });
        await submit();
        expect(await screen.findByText('Too many requests.')).toBeTruthy();
    });
});

describe('the account security page (#4645)', () => {
    beforeEach(() => {
        mockAuth.mockResolvedValue({ user: { id: 'u-1', email: 'ada@example.com' } });
    });

    it('tells an account with no password so, and offers no form', async () => {
        mockHasPassword.mockResolvedValue(false);
        render(await AccountSecurityPage());
        expect(mockHasPassword).toHaveBeenCalledWith('u-1');
        expect(screen.getByText(S.passwordlessNotice)).toBeTruthy();
        expect(document.querySelector('input[type="password"]')).toBeNull();
    });

    it('offers the form to an account with a password', async () => {
        mockHasPassword.mockResolvedValue(true);
        render(await AccountSecurityPage());
        expect(document.querySelectorAll('input[type="password"]')).toHaveLength(3);
        expect(screen.queryByText(S.passwordlessNotice)).toBeNull();
    });
});
