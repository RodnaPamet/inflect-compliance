/**
 * The Microsoft organisation-wide authorisation card on Admin → Integrations
 * (#5937 step 3).
 *
 *   - It says whether the workspace has granted, when, by whom and in which
 *     directory, and offers "Authorise for your organisation" / "Authorise
 *     again" with design point 3 stated beside the button.
 *   - A deployment with no Microsoft client says so instead of offering a
 *     button that would fail at Microsoft.
 *   - A viewer the routes would refuse is offered no write and sends no read.
 *   - Revoking a grant everybody relies on takes a confirmation.
 *   - The callback's `?calendar=<outcome>` is worded, one message per outcome
 *     in both catalogues, and removed from the URL.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, unknown>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) {
                const t = (key: string, params?: Record<string, unknown>) => {
                    const v = walk(walk(en, ns), key);
                    if (typeof v !== 'string') return key;
                    let s = v;
                    for (const [p, val] of Object.entries(params ?? {})) {
                        s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                    }
                    return s;
                };
                cache.set(ns, t);
            }
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

let mockSearch = new URLSearchParams();
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/integrations',
    useSearchParams: () => mockSearch,
}));

const mockViewer: { membershipRole: string; canAdmin: boolean } = { membershipRole: 'ADMIN', canAdmin: true };
jest.mock('@/lib/tenant-context-provider', () => {
    const { getPermissionsForRole } = jest.requireActual('@/lib/permissions');
    return {
        useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
        useTenantHref: () => (p: string) => `/t/acme${p}`,
        useTenantContext: () => ({
            membershipRole: mockViewer.membershipRole,
            appPermissions: getPermissionsForRole(mockViewer.membershipRole),
            permissions: { canAdmin: mockViewer.canAdmin, canWrite: mockViewer.canAdmin },
        }),
    };
});

import { CalendarConsentCard } from '@/app/t/[tenantSlug]/(app)/admin/integrations/CalendarConsentCard';
import { CALENDAR_ADMIN_CONSENT_OUTCOMES } from '@/lib/calendar-admin-consent-outcomes';

const EN = require('../../messages/en.json').admin.calendarConsent as Record<string, string> & {
    outcome: Record<string, string>;
};
const BG = require('../../messages/bg.json').admin.calendarConsent as { outcome: Record<string, string> };

const DIRECTORY = '72f988bf-86f1-41af-91ab-2d7cd011db47';

type Consent = {
    provider: string;
    granted: boolean;
    grantedAt: string | null;
    revokedAt: string | null;
    externalTenantId: string | null;
    grantedBy: { name: string | null; email: string | null } | null;
};
const NEVER: Consent = {
    provider: 'outlook-calendar',
    granted: false,
    grantedAt: null,
    revokedAt: null,
    externalTenantId: null,
    grantedBy: null,
};
const GRANTED: Consent = {
    provider: 'outlook-calendar',
    granted: true,
    grantedAt: '2026-11-20T09:00:00.000Z',
    revokedAt: null,
    externalTenantId: DIRECTORY,
    grantedBy: { name: 'Ada Admin', email: 'ada@acme.test' },
};

let state: { consent: Consent; configured: boolean };
const calls: Array<{ url: string; method: string }> = [];

/** jsdom has no `Response`; the card reads `ok`, `status` and `json()`. */
function json(body: unknown, status = 200) {
    return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
            if (body === null) throw new SyntaxError('no body');
            return body;
        },
    } as Response);
}

beforeEach(() => {
    calls.length = 0;
    mockSearch = new URLSearchParams();
    mockViewer.membershipRole = 'ADMIN';
    mockViewer.canAdmin = true;
    state = { consent: NEVER, configured: true };
    window.history.replaceState(null, '', '/t/acme/admin/integrations');
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method });
        if (url.startsWith('/api/t/acme/admin/calendar/consent')) {
            if (method === 'GET') return json({ consents: [state.consent], microsoftClientConfigured: state.configured });
            if (method === 'DELETE') {
                state = { ...state, consent: { ...state.consent, granted: false, revokedAt: '2026-11-25T10:00:00.000Z' } };
                return json(null, 204);
            }
            if (method === 'POST') return json({ error: { message: 'Conflict' } }, 409);
        }
        return json({ error: { message: 'unexpected' } }, 500);
    }) as unknown as typeof fetch;
});

describe('what the card says about the grant', () => {
    it('granted: when, by whom, in which directory, with Authorise again beside point 3, and Revoke', async () => {
        state.consent = GRANTED;
        render(<CalendarConsentCard />);
        expect(await screen.findByText(EN.statusGranted)).toBeTruthy();
        expect(screen.getByText(/^Authorised on /)).toBeTruthy();
        expect(screen.getByText('By Ada Admin')).toBeTruthy();
        expect(screen.getByText(`Microsoft directory: ${DIRECTORY}`)).toBeTruthy();
        expect(screen.getByTestId('calendar-consent-scope-note').textContent).toBe(EN.scopeNote);
        expect(screen.getByRole('button', { name: EN.authoriseAgain })).toBeTruthy();
        expect(screen.getByRole('button', { name: EN.revoke })).toBeTruthy();
    });

    it('never granted: says so, offers Authorise for your organisation, and no Revoke', async () => {
        render(<CalendarConsentCard />);
        expect(await screen.findByText(EN.neverGranted)).toBeTruthy();
        expect(screen.getByText(EN.statusNotGranted)).toBeTruthy();
        expect(screen.getByRole('button', { name: EN.authorise })).toBeTruthy();
        expect(screen.queryByRole('button', { name: EN.revoke })).toBeNull();
    });

    it('revoked: shows when it was granted and when revoked, and offers to authorise again', async () => {
        state.consent = { ...GRANTED, granted: false, revokedAt: '2026-11-24T08:00:00.000Z' };
        render(<CalendarConsentCard />);
        expect(await screen.findByText(EN.statusRevoked)).toBeTruthy();
        expect(screen.getByText(/^Revoked on /)).toBeTruthy();
        expect(screen.getByRole('button', { name: EN.authorise })).toBeTruthy();
        expect(screen.queryByRole('button', { name: EN.revoke })).toBeNull();
    });

    it('no Microsoft client configured: says so and offers no Authorise button', async () => {
        state.configured = false;
        render(<CalendarConsentCard />);
        expect(await screen.findByTestId('calendar-consent-not-configured')).toBeTruthy();
        expect(screen.getByTestId('calendar-consent-not-configured').textContent).toBe(EN.notConfigured);
        expect(screen.queryByRole('button', { name: EN.authorise })).toBeNull();
        expect(screen.queryByTestId('calendar-consent-scope-note')).toBeNull();
    });

    it('a viewer without admin.manage is offered nothing and sends no read', async () => {
        mockViewer.membershipRole = 'READER';
        mockViewer.canAdmin = false;
        render(<CalendarConsentCard />);
        // Give any effect a turn.
        await waitFor(() => expect(screen.getByText(EN.title)).toBeTruthy());
        expect(calls).toHaveLength(0);
        expect(screen.queryByRole('button', { name: EN.authorise })).toBeNull();
        expect(screen.queryByRole('button', { name: EN.revoke })).toBeNull();
    });
});

describe('writes', () => {
    it('Revoke asks for confirmation before it sends the DELETE', async () => {
        state.consent = GRANTED;
        render(<CalendarConsentCard />);
        fireEvent.click(await screen.findByRole('button', { name: EN.revoke }));

        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain(EN.revokeDescription);
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

        // Cancelling sends nothing.
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

        fireEvent.click(screen.getByRole('button', { name: EN.revoke }));
        const confirm = await screen.findByRole('dialog');
        const confirmButton = Array.from(confirm.querySelectorAll('button')).find(
            (b) => b.textContent === EN.revokeConfirm,
        )!;
        fireEvent.click(confirmButton);

        await waitFor(() =>
            expect(calls).toContainEqual({ url: '/api/t/acme/admin/calendar/consent?provider=outlook-calendar', method: 'DELETE' }),
        );
        expect(await screen.findByText(EN.revoked)).toBeTruthy();
        expect(await screen.findByText(EN.statusRevoked)).toBeTruthy();
    });

    it('Authorise POSTs to start the flow, and a refusal is shown rather than followed', async () => {
        render(<CalendarConsentCard />);
        fireEvent.click(await screen.findByRole('button', { name: EN.authorise }));
        await waitFor(() =>
            expect(calls).toContainEqual({ url: '/api/t/acme/admin/calendar/consent?provider=outlook-calendar', method: 'POST' }),
        );
        expect((await screen.findByTestId('calendar-consent-notice')).textContent).toBe('Conflict');
    });
});

describe('the callback\'s outcome', () => {
    it('is worded, and removed from the URL while the message stays', async () => {
        window.history.replaceState(null, '', '/t/acme/admin/integrations?calendar=not_directory_admin&tab=x');
        mockSearch = new URLSearchParams('calendar=not_directory_admin&tab=x');
        render(<CalendarConsentCard />);
        expect(screen.getByTestId('calendar-consent-result').textContent).toBe(EN.outcome.not_directory_admin);
        await waitFor(() => expect(window.location.search).toBe('?tab=x'));
        expect(screen.getByTestId('calendar-consent-result').textContent).toBe(EN.outcome.not_directory_admin);
    });

    it('is shown to a viewer who has just lost the permission', async () => {
        mockViewer.membershipRole = 'READER';
        mockViewer.canAdmin = false;
        mockSearch = new URLSearchParams('calendar=not_permitted');
        render(<CalendarConsentCard />);
        expect(screen.getByTestId('calendar-consent-result').textContent).toBe(EN.outcome.not_permitted);
    });

    it('an unknown value is not reflected', async () => {
        mockSearch = new URLSearchParams('calendar=<b>pwned</b>');
        render(<CalendarConsentCard />);
        expect(screen.queryByTestId('calendar-consent-result')).toBeNull();
        expect(document.body.textContent).not.toContain('pwned');
    });

    it.each(CALENDAR_ADMIN_CONSENT_OUTCOMES)('%s has a message in en and bg', (outcome) => {
        expect(EN.outcome[outcome]).toEqual(expect.any(String));
        expect(BG.outcome[outcome]).toEqual(expect.any(String));
        expect(BG.outcome[outcome]).not.toBe(EN.outcome[outcome]);
    });

    it('the catalogues word exactly the closed set', () => {
        expect(Object.keys(EN.outcome).sort()).toEqual([...CALENDAR_ADMIN_CONSENT_OUTCOMES].sort());
        expect(Object.keys(BG.outcome).sort()).toEqual([...CALENDAR_ADMIN_CONSENT_OUTCOMES].sort());
    });
});
