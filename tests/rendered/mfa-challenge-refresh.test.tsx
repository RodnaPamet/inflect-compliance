/**
 * The MFA challenge page rewrites the session cookie before it navigates on.
 *
 * The edge gate reads `mfaPending` from the session cookie, and only NextAuth's
 * session route re-signs it. The page used to navigate straight on after a
 * correct code, so the cookie still said `mfaPending: true` and the gate sent
 * the user back to this page — a workspace that required MFA admitted nobody.
 * tests/unit/mfa-challenge-session-cookie.test.ts proves the session route is
 * what clears it, end to end through the real middleware; this file proves the
 * page calls it, in order, and only after the code is accepted.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// One instance each: the page's effects are keyed on these.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`;
    const href = (p: string) => `/t/acme${p}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

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

// `next` is a hash so the page's navigation stays inside jsdom.
jest.mock('next/navigation', () => {
    const searchParams = new URLSearchParams('next=%23after-mfa');
    return { useSearchParams: () => searchParams };
});

import MfaChallengePage from '@/app/t/[tenantSlug]/(app)/auth/mfa/page';

function installFetch(verifySucceeds: boolean) {
    const calls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        let body: unknown = {};
        if (url.endsWith('/security/mfa/enroll')) body = { isVerified: true };
        else if (url.endsWith('/security/mfa/challenge/verify')) body = verifySucceeds ? { success: true } : { success: false };
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
}

async function submitCode() {
    const input = await screen.findByPlaceholderText('000000');
    fireEvent.change(input, { target: { value: '123456' } });
    await act(async () => {
        fireEvent.click(document.getElementById('mfa-challenge-submit') as HTMLElement);
    });
}

beforeEach(() => {
    window.history.replaceState({}, '', '/t/acme/auth/mfa');
});

describe('MFA challenge page — after the code', () => {
    it('refreshes the session cookie after a correct code, and only then navigates on', async () => {
        const calls = installFetch(true);
        render(<MfaChallengePage />);
        await submitCode();

        await waitFor(() => expect(window.location.hash).toBe('#after-mfa'));
        const verify = calls.indexOf('POST /api/t/acme/security/mfa/challenge/verify');
        const refresh = calls.indexOf('GET /api/auth/session');
        expect(verify).toBeGreaterThanOrEqual(0);
        expect(refresh).toBeGreaterThan(verify);
    });

    it('does not refresh or navigate when the code is wrong', async () => {
        const calls = installFetch(false);
        render(<MfaChallengePage />);
        await submitCode();

        await waitFor(() => expect(calls).toContain('POST /api/t/acme/security/mfa/challenge/verify'));
        expect(calls).not.toContain('GET /api/auth/session');
        expect(window.location.hash).toBe('');
    });
});
