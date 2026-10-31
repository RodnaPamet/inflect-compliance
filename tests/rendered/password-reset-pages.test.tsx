/** @jest-environment jsdom */

/**
 * The forgot- and reset-password pages say what happened (#4687, #4688).
 *
 *   - A rate-limited reset request says so. The limit is keyed on the
 *     network address, not the account, so this reveals nothing about any
 *     account; claiming "sent" left the person waiting for nothing.
 *   - A reset refusal is the page's own sentence, not the route's English
 *     one, and a dead link offers a new one.
 *   - A password over the maximum is refused before it is sent.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const params = new URLSearchParams('token=tok-1');
jest.mock('next/navigation', () => ({
    useSearchParams: () => params,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

import ForgotPasswordPage from '@/app/forgot-password/page';
import ResetPasswordPage from '@/app/reset-password/page';

const en = jest.requireActual('../../messages/en.json') as {
    auth: {
        forgot: Record<string, string>;
        reset: Record<string, string> & { refused: Record<string, string> };
    };
};

function answer(status: number, body: unknown = {}) {
    global.fetch = jest.fn(async () => ({ ok: status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

function fill(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
}

describe('forgot password', () => {
    it('says a rate-limited request was not sent', async () => {
        answer(429, { error: 'Too many requests' });
        render(<ForgotPasswordPage />);
        fill(en.auth.forgot.emailLabel, 'ana@example.com');
        fireEvent.click(screen.getByRole('button', { name: en.auth.forgot.sendResetLink }));

        expect(await screen.findByText(en.auth.forgot.tooManyRequests)).toBeTruthy();
        expect(screen.queryByText(en.auth.forgot.resetSent)).toBeNull();
    });

    it('says "sent" whatever else the answer is, so it never reveals an account', async () => {
        answer(200, { ok: true });
        render(<ForgotPasswordPage />);
        fill(en.auth.forgot.emailLabel, 'ana@example.com');
        fireEvent.click(screen.getByRole('button', { name: en.auth.forgot.sendResetLink }));
        expect(await screen.findByText(en.auth.forgot.resetSent)).toBeTruthy();
    });
});

describe('reset password', () => {
    function submit(password: string) {
        fill(en.auth.reset.newPasswordLabel, password);
        fill(en.auth.reset.confirmLabel, password);
        fireEvent.click(screen.getByRole('button', { name: en.auth.reset.resetPassword }));
    }

    it('shows a named refusal in the user’s language, with a new-link offer for a dead link', async () => {
        answer(400, { error: 'This password reset link has expired. Please request a new one.', code: 'RESET_LINK_EXPIRED' });
        render(<ResetPasswordPage />);
        submit('pass-ok-1234');

        expect(await screen.findByText(en.auth.reset.refused.RESET_LINK_EXPIRED)).toBeTruthy();
        expect(screen.getByRole('link', { name: en.auth.reset.requestNewLink })).toHaveAttribute('href', '/forgot-password');
    });

    it('offers no new link for a password refusal', async () => {
        answer(400, { error: 'breached', code: 'PASSWORD_BREACHED' });
        render(<ResetPasswordPage />);
        submit('pass-ok-1234');

        expect(await screen.findByText(en.auth.reset.refused.PASSWORD_BREACHED)).toBeTruthy();
        expect(screen.queryByRole('link', { name: en.auth.reset.requestNewLink })).toBeNull();
    });

    it('says too many attempts on a 429', async () => {
        answer(429, { error: 'Too many requests' });
        render(<ResetPasswordPage />);
        submit('pass-ok-1234');
        expect(await screen.findByText(en.auth.reset.tooManyAttempts)).toBeTruthy();
    });

    it('refuses a password over the maximum before sending it', () => {
        answer(200, { ok: true });
        render(<ResetPasswordPage />);
        submit('x'.repeat(129));
        expect(screen.getByText(en.auth.reset.tooLong)).toBeTruthy();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
