/**
 * The SSO completion page redeems the hand-off through NextAuth once, then
 * goes on to where the sign-in was headed.
 *
 * The SSO callbacks leave a single-use hand-off in an HttpOnly cookie and send
 * the browser here; NextAuth's `sso-handoff` provider redeems it and opens the
 * session (tests/unit/sso-handoff-session.test.ts runs that half for real).
 * This page is the trigger. Because the hand-off is single-use, a second call
 * — React's development double-run of effects — would fail and could show an
 * error over a sign-in that had worked, so it must ask exactly once.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

const signInMock = jest.fn();
jest.mock('next-auth/react', () => ({ signIn: (...args: unknown[]) => signInMock(...args) }));
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

import { SsoComplete } from '@/app/login/sso-complete/SsoComplete';

const en = require('../../messages/en.json');

beforeEach(() => {
    signInMock.mockReset();
    window.history.replaceState({}, '', '/login/sso-complete');
});

describe('SSO completion page', () => {
    it('asks NextAuth to redeem the hand-off once, then navigates on', async () => {
        signInMock.mockResolvedValue({ ok: true, error: null, status: 200, url: '/t/beta/dashboard' });
        // `next` is a hash so the navigation stays inside jsdom.
        render(
            <React.StrictMode>
                <SsoComplete next="#signed-in" />
            </React.StrictMode>,
        );

        await waitFor(() => expect(window.location.hash).toBe('#signed-in'));
        expect(signInMock).toHaveBeenCalledTimes(1);
        expect(signInMock).toHaveBeenCalledWith('sso-handoff', { redirect: false });
    });

    it('says so, and offers the way back, when the hand-off does not redeem', async () => {
        signInMock.mockResolvedValue({ ok: true, error: 'CredentialsSignin', status: 401, url: null });
        render(<SsoComplete next="#signed-in" />);

        expect(await screen.findByText(en.login.errors.ssoIncomplete)).toBeInTheDocument();
        expect(document.getElementById('sso-complete-back-to-login')).toHaveAttribute('href', '/login');
        expect(window.location.hash).toBe('');
    });
});
