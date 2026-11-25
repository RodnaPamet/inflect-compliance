/**
 * #5937 step 4 — the Connect control on `/calendar`.
 *
 * Driven through the real calendar page (`CalendarClient`): the header's
 * "Sync to my calendar" action opens the panel, the panel words what the
 * server's read says, Connect follows the returned `authorizeUrl`, a
 * disconnect needs a confirm and handles both of its answers, and a connect's
 * `?calendar=<outcome>` is said once and taken out of the address.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';

const toastCalls: Array<[string, string]> = [];
jest.mock('sonner', () => {
    const record = (kind: string) => (m: string) => {
        toastCalls.push([kind, String(m)]);
    };
    return {
        Toaster: () => null,
        toast: Object.assign(record('default'), {
            custom: jest.fn(), dismiss: jest.fn(), success: record('success'),
            error: record('error'), warning: record('warning'), info: record('info'),
            message: jest.fn(), loading: jest.fn(),
        }),
    };
});

let currentSearch = '';
const replaceMock = jest.fn((url: string) => {
    currentSearch = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
});
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme-corp' }),
    useRouter: () => ({ replace: replaceMock, push: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme-corp/calendar',
    useSearchParams: () => new URLSearchParams(currentSearch),
}));

// The panel is `next/dynamic`; here it resolves through React.lazy.
jest.mock('next/dynamic', () => {
    const R = jest.requireActual('react') as typeof React;
    return (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
        const Lazy = R.lazy(() => loader().then((C) => ({ default: C })));
        const Dynamic = (props: Record<string, unknown>) => (
            <R.Suspense fallback={null}>
                <Lazy {...props} />
            </R.Suspense>
        );
        return Dynamic;
    };
});

const leaveForProvider = jest.fn();
jest.mock('@/app/t/[tenantSlug]/(app)/calendar/_components/connect/leave-for-provider', () => ({
    leaveForProvider: (url: string) => leaveForProvider(url),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            (en as Record<string, unknown>)[ns],
        );
    // Enough ICU for these messages: `{name}` and `{n, plural, one {…} other {…}}`
    // with `#`.
    const format = (template: string, params: Record<string, unknown> = {}) => {
        let out = template.replace(
            /\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
            (_m, p: string, one: string, other: string) => {
                const n = Number(params[p]);
                return (n === 1 ? one : other).replace(/#/g, String(n));
            },
        );
        for (const [p, v] of Object.entries(params)) out = out.replace(new RegExp(`\\{${p}\\}`, 'g'), String(v));
        return out;
    };
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const t = ((key: string, params?: Record<string, unknown>) => {
            const v = lookup(ns, key);
            return typeof v === 'string' ? format(v, params) : key;
        }) as ((key: string, params?: Record<string, unknown>) => string) & Record<string, unknown>;
        t.has = (key: string) => typeof lookup(ns, key) === 'string';
        t.raw = (key: string) => lookup(ns, key);
        t.rich = (key: string) => lookup(ns, key) ?? key;
        return t;
    };
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next-auth/react', () => ({ signOut: jest.fn(), signIn: jest.fn() }));

import { SWRConfig } from 'swr';
import { CalendarClient } from '@/app/t/[tenantSlug]/(app)/calendar/CalendarClient';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';
import { OUTCOME_COPY } from '@/app/t/[tenantSlug]/(app)/calendar/_components/connect/connect-copy';
import en from '../../messages/en.json';

const copy = en.calendarConnect;

const TENANT_CTX = {
    userId: 'user-1', tenantId: 'tenant-1', tenantSlug: 'acme-corp', tenantName: 'Acme Corp',
    role: 'EDITOR' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
    appPermissions: getPermissionsForRole('EDITOR'),
    modules: { processCanvas: false },
};

const calendarBody = {
    events: [],
    counts: { total: 0, partial: false },
    truncation: { capped: false, sources: [], perSourceLimit: 500, totalCap: 5000, totalCapped: false },
    omittedSources: [], failedSources: [],
    todayYmd: new Date().toISOString().slice(0, 10),
    range: { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' },
};

type Provider = 'google-calendar' | 'outlook-calendar';
type Connection = {
    id: string; provider: Provider; connectedAt: string; revokedAt: string | null;
    lastPushedAt: string | null; disconnectRequestedAt: string | null; undeletedEventCount: number;
    state: 'CONNECTED' | 'DISCONNECTING' | 'DISCONNECTED' | 'STOPPED';
};
type ProviderView = { provider: Provider; connectable: boolean; refusal: string | null };

let connectionsBody: { connections: Connection[]; providers: ProviderView[] };
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
let override: ((url: string, init?: RequestInit) => Reply | undefined) | null = null;
const fetchMock = jest.fn(async (url: string, init?: RequestInit): Promise<Reply> => {
    const u = String(url);
    const o = override?.(u, init);
    if (o) return o;
    if (u.includes('/calendar/connections')) {
        return { ok: true, status: 200, json: async () => connectionsBody };
    }
    return { ok: true, status: 200, json: async () => calendarBody };
});

const BOTH_OPEN: ProviderView[] = [
    { provider: 'google-calendar', connectable: true, refusal: null },
    { provider: 'outlook-calendar', connectable: true, refusal: null },
];

const conn = (provider: Provider, patch: Partial<Connection> = {}): Connection => ({
    id: `c-${provider}`, provider, connectedAt: '2026-11-02T09:00:00.000Z', revokedAt: null,
    lastPushedAt: '2026-11-24T03:00:00.000Z', disconnectRequestedAt: null, undeletedEventCount: 0,
    state: 'CONNECTED', ...patch,
});

beforeEach(() => {
    currentSearch = '';
    replaceMock.mockClear();
    leaveForProvider.mockClear();
    toastCalls.length = 0;
    fetchMock.mockClear();
    override = null;
    connectionsBody = { connections: [], providers: BOTH_OPEN };
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

function mount() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <TooltipProvider>
                    <CalendarClient tenantSlug="acme-corp" />
                </TooltipProvider>
            </TenantProvider>
        </SWRConfig>,
    );
}

const connectionsRequests = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/calendar/connections'));

async function openPanel() {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: copy.open }));
    await screen.findByText(copy.intro);
}

async function row(provider: Provider): Promise<HTMLElement> {
    return waitFor(() => {
        const el = document.getElementById(`calendar-connect-${provider}`);
        if (!el) throw new Error(`no ${provider} row`);
        return el;
    });
}

describe('opening the panel', () => {
    it('reads the connections only when the panel opens, and says what is copied', async () => {
        mount();
        const button = await screen.findByRole('button', { name: copy.open });
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(connectionsRequests()).toHaveLength(0);

        fireEvent.click(button);
        await screen.findByText(copy.intro);
        for (const k of ['pointOwn', 'pointPrivate', 'pointLanguage', 'pointDisconnect'] as const) {
            expect(screen.getByText(copy[k])).toBeInTheDocument();
        }
        await waitFor(() => expect(connectionsRequests()).toHaveLength(1));
    });
});

describe('not connected', () => {
    it('offers Connect for each provider, with each provider\'s consent model', async () => {
        await openPanel();
        const google = await row('google-calendar');
        expect(within(google).getByText(copy.state.notConnected)).toBeInTheDocument();
        expect(within(google).getByText(copy.consentGoogle)).toBeInTheDocument();
        expect(within(google).getByRole('button', { name: 'Connect Google Calendar' })).toBeEnabled();
        const outlook = await row('outlook-calendar');
        expect(within(outlook).getByText(copy.consentOutlook)).toBeInTheDocument();
        expect(within(outlook).getByRole('button', { name: 'Connect Outlook' })).toBeEnabled();
    });

    it('Connect POSTs and follows the authorizeUrl the server returns', async () => {
        override = (u, init) =>
            u.includes('/calendar/connect?') && init?.method === 'POST'
                ? { ok: true, status: 200, json: async () => ({ authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }) }
                : undefined;
        await openPanel();
        fireEvent.click(within(await row('google-calendar')).getByRole('button', { name: 'Connect Google Calendar' }));
        await waitFor(() =>
            expect(leaveForProvider).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'),
        );
        const post = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST');
        expect(String(post?.[0])).toBe('/api/t/acme-corp/calendar/connect?provider=google-calendar');
    });

    it('a connect the server refuses shows the refusal, not a button, and re-reads the state', async () => {
        override = (u, init) =>
            u.includes('/calendar/connect?') && init?.method === 'POST'
                ? {
                      ok: false, status: 403,
                      json: async () => ({ error: { code: 'FORBIDDEN', message: 'x', details: { reason: 'ADMIN_CONSENT_WITHDRAWN' } } }),
                  }
                : undefined;
        await openPanel();
        fireEvent.click(within(await row('outlook-calendar')).getByRole('button', { name: 'Connect Outlook' }));
        const outlook = await row('outlook-calendar');
        await within(outlook).findByText(copy.refusal.ADMIN_CONSENT_WITHDRAWN);
        expect(within(outlook).queryByRole('button', { name: /Connect/ })).toBeNull();
        expect(leaveForProvider).not.toHaveBeenCalled();
        await waitFor(() => expect(connectionsRequests().length).toBeGreaterThanOrEqual(2));
    });

    it('a connect that fails for no stated reason says so and keeps the button', async () => {
        override = (u, init) =>
            u.includes('/calendar/connect?') && init?.method === 'POST'
                ? { ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL', message: 'boom' } }) }
                : undefined;
        await openPanel();
        fireEvent.click(within(await row('google-calendar')).getByRole('button', { name: 'Connect Google Calendar' }));
        const google = await row('google-calendar');
        await within(google).findByText('Could not start connecting Google Calendar. Try again.');
        expect(within(google).getByRole('button', { name: 'Connect Google Calendar' })).toBeEnabled();
        expect(screen.queryByText('boom')).toBeNull();
    });
});

describe('cannot connect — the reason, and no button that would fail', () => {
    it.each([
        ['google-calendar', 'NOT_CONFIGURED', 'Google Calendar is not set up in this installation of Inflect, so it cannot be connected.'],
        ['outlook-calendar', 'NOT_CONFIGURED', 'Outlook is not set up in this installation of Inflect, so it cannot be connected.'],
        ['outlook-calendar', 'ADMIN_CONSENT_NOT_GRANTED', copy.refusal.ADMIN_CONSENT_NOT_GRANTED],
        ['outlook-calendar', 'ADMIN_CONSENT_WITHDRAWN', copy.refusal.ADMIN_CONSENT_WITHDRAWN],
    ] as const)('%s, %s', async (provider, refusal, sentence) => {
        connectionsBody = {
            connections: [],
            providers: BOTH_OPEN.map((p) => (p.provider === provider ? { provider, connectable: false, refusal } : p)),
        };
        await openPanel();
        const r = await row(provider);
        expect(within(r).getByText(sentence)).toBeInTheDocument();
        expect(within(r).queryByRole('button')).toBeNull();
        // The other provider is still offered.
        const other = provider === 'google-calendar' ? 'outlook-calendar' : 'google-calendar';
        expect(within(await row(other)).getByRole('button', { name: /^Connect / })).toBeEnabled();
    });

    it('Microsoft without consent tells the person to ask their administrator', async () => {
        expect(copy.refusal.ADMIN_CONSENT_NOT_GRANTED).toMatch(/Ask your administrator/);
    });
});

describe('connected', () => {
    it('shows since when and the last update, and offers Disconnect', async () => {
        connectionsBody = { connections: [conn('google-calendar')], providers: BOTH_OPEN };
        await openPanel();
        const google = await row('google-calendar');
        expect(within(google).getByText(copy.state.connected)).toBeInTheDocument();
        expect(within(google).getByText(/^Connected on /)).toBeInTheDocument();
        expect(within(google).getByText(/^Last updated on /)).toBeInTheDocument();
        expect(within(google).getByRole('button', { name: 'Disconnect Google Calendar' })).toBeEnabled();
        expect(within(google).queryByRole('button', { name: /^Connect / })).toBeNull();
    });

    it('a connection not yet pushed says when it will be', async () => {
        connectionsBody = { connections: [conn('google-calendar', { lastPushedAt: null })], providers: BOTH_OPEN };
        await openPanel();
        expect(within(await row('google-calendar')).getByText(copy.notPushedYet)).toBeInTheDocument();
    });

    it('a live Outlook connection whose organisation consent is gone says it is not updated', async () => {
        connectionsBody = {
            connections: [conn('outlook-calendar')],
            providers: [BOTH_OPEN[0], { provider: 'outlook-calendar', connectable: false, refusal: 'ADMIN_CONSENT_WITHDRAWN' }],
        };
        await openPanel();
        const outlook = await row('outlook-calendar');
        expect(within(outlook).getByText(copy.consentGoneWhileConnected)).toBeInTheDocument();
        // Disconnecting is still the person's to do.
        expect(within(outlook).getByRole('button', { name: 'Disconnect Outlook' })).toBeEnabled();
    });
});

describe('stopped and disconnecting', () => {
    it('a connection the provider stopped offers Reconnect and counts what is left behind', async () => {
        connectionsBody = {
            connections: [conn('google-calendar', { state: 'STOPPED', revokedAt: '2026-11-20T00:00:00.000Z', undeletedEventCount: 4 })],
            providers: BOTH_OPEN,
        };
        await openPanel();
        const google = await row('google-calendar');
        expect(within(google).getByText(copy.state.stopped)).toBeInTheDocument();
        expect(within(google).getByText("Google Calendar stopped accepting Inflect's updates. Reconnect to resume.")).toBeInTheDocument();
        expect(within(google).getByText(/^4 events Inflect added are still in your calendar\./)).toBeInTheDocument();
        expect(within(google).getByRole('button', { name: 'Reconnect Google Calendar' })).toBeEnabled();
    });

    it('a stopped Outlook connection without the consent shows why it cannot be reconnected', async () => {
        connectionsBody = {
            connections: [conn('outlook-calendar', { state: 'STOPPED', revokedAt: '2026-11-20T00:00:00.000Z' })],
            providers: [BOTH_OPEN[0], { provider: 'outlook-calendar', connectable: false, refusal: 'ADMIN_CONSENT_NOT_GRANTED' }],
        };
        await openPanel();
        const outlook = await row('outlook-calendar');
        expect(within(outlook).getByText(copy.refusal.ADMIN_CONSENT_NOT_GRANTED)).toBeInTheDocument();
        expect(within(outlook).queryByRole('button')).toBeNull();
    });

    it('a disconnect still removing events says how many are left, and offers nothing to click', async () => {
        connectionsBody = {
            connections: [conn('outlook-calendar', { state: 'DISCONNECTING', disconnectRequestedAt: '2026-11-24T10:00:00.000Z', undeletedEventCount: 3 })],
            providers: BOTH_OPEN,
        };
        await openPanel();
        const outlook = await row('outlook-calendar');
        expect(within(outlook).getByText(copy.state.disconnecting)).toBeInTheDocument();
        expect(within(outlook).getByText(/^Removing the events Inflect added: 3 are still in your calendar\./)).toBeInTheDocument();
        expect(within(outlook).queryByRole('button')).toBeNull();
    });

    it('after a disconnect that left events behind, Connect is offered again with the count', async () => {
        connectionsBody = {
            connections: [conn('google-calendar', { state: 'DISCONNECTED', revokedAt: '2026-11-20T00:00:00.000Z', undeletedEventCount: 1 })],
            providers: BOTH_OPEN,
        };
        await openPanel();
        const google = await row('google-calendar');
        expect(within(google).getByText(copy.state.notConnected)).toBeInTheDocument();
        expect(within(google).getByText(/^1 event Inflect added is still in your calendar\./)).toBeInTheDocument();
        expect(within(google).getByRole('button', { name: 'Connect Google Calendar' })).toBeEnabled();
    });
});

describe('disconnect', () => {
    const confirmDialog = () => screen.findByRole('dialog', { name: 'Disconnect Google Calendar?' });

    it('needs a confirm that says it deletes the pushed events; cancel sends nothing', async () => {
        connectionsBody = { connections: [conn('google-calendar')], providers: BOTH_OPEN };
        await openPanel();
        fireEvent.click(within(await row('google-calendar')).getByRole('button', { name: 'Disconnect Google Calendar' }));
        const dialog = await confirmDialog();
        expect(within(dialog).getAllByText(/removes the deadlines it added to Google Calendar/).length).toBeGreaterThan(0);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Disconnect Google Calendar?' })).toBeNull());
        expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);
    });

    it('204: every pushed event is gone — says so and re-reads', async () => {
        connectionsBody = { connections: [conn('google-calendar')], providers: BOTH_OPEN };
        override = (u, init) => {
            if (init?.method !== 'DELETE') return undefined;
            connectionsBody = {
                connections: [conn('google-calendar', { state: 'DISCONNECTED', revokedAt: new Date().toISOString() })],
                providers: BOTH_OPEN,
            };
            return { ok: true, status: 204, json: async () => ({}) };
        };
        await openPanel();
        fireEvent.click(within(await row('google-calendar')).getByRole('button', { name: 'Disconnect Google Calendar' }));
        fireEvent.click(within(await confirmDialog()).getByRole('button', { name: copy.confirmLabel }));

        await waitFor(() => expect(toastCalls).toContainEqual(['success', 'Google Calendar is disconnected. The events Inflect added were removed.']));
        const del = fetchMock.mock.calls.find(([, i]) => i?.method === 'DELETE');
        expect(String(del?.[0])).toBe('/api/t/acme-corp/calendar/connections?provider=google-calendar');
        const google = await row('google-calendar');
        await within(google).findByRole('button', { name: 'Connect Google Calendar' });
    });

    it('202: still disconnecting — says how many remain and shows the disconnecting state', async () => {
        connectionsBody = { connections: [conn('outlook-calendar')], providers: BOTH_OPEN };
        override = (u, init) => {
            if (init?.method !== 'DELETE') return undefined;
            connectionsBody = {
                connections: [conn('outlook-calendar', { state: 'DISCONNECTING', disconnectRequestedAt: new Date().toISOString(), undeletedEventCount: 2 })],
                providers: BOTH_OPEN,
            };
            return { ok: true, status: 202, json: async () => ({ status: 'disconnecting', removed: 25, remaining: 2 }) };
        };
        await openPanel();
        fireEvent.click(within(await row('outlook-calendar')).getByRole('button', { name: 'Disconnect Outlook' }));
        fireEvent.click(within(await screen.findByRole('dialog', { name: 'Disconnect Outlook?' })).getByRole('button', { name: copy.confirmLabel }));

        await waitFor(() =>
            expect(toastCalls).toContainEqual(['info', 'Outlook is disconnecting: 2 events are still being removed, and Inflect tries again tonight.']),
        );
        const outlook = await row('outlook-calendar');
        await within(outlook).findByText(/^Removing the events Inflect added: 2 are still in your calendar\./);
    });

    it('a failed disconnect keeps the confirm open and says so', async () => {
        connectionsBody = { connections: [conn('google-calendar')], providers: BOTH_OPEN };
        override = (_u, init) =>
            init?.method === 'DELETE' ? { ok: false, status: 500, json: async () => ({}) } : undefined;
        await openPanel();
        fireEvent.click(within(await row('google-calendar')).getByRole('button', { name: 'Disconnect Google Calendar' }));
        fireEvent.click(within(await confirmDialog()).getByRole('button', { name: copy.confirmLabel }));
        await waitFor(() => expect(toastCalls).toContainEqual(['error', 'Could not disconnect Google Calendar. Try again.']));
        expect(screen.getByRole('dialog', { name: 'Disconnect Google Calendar?' })).toBeInTheDocument();
    });
});

describe('the result of a connect, said once and taken out of the address', () => {
    it.each(Object.keys(OUTCOME_COPY).map((o) => [o]))('%s', async (outcome) => {
        currentSearch = `view=agenda&calendar=${outcome}`;
        const { rerender } = mount();
        const notice = await waitFor(() => {
            const el = document.getElementById('calendar-connect-outcome');
            if (!el) throw new Error('no notice');
            return el;
        });
        // Every outcome is worded: an unworded one would print its key.
        expect((copy.outcome as Record<string, string>)[outcome]).toEqual(expect.any(String));
        expect(notice).toHaveTextContent((copy.outcome as Record<string, string>)[outcome]);
        // Removed with one replace that keeps every other parameter.
        await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/t/acme-corp/calendar?view=agenda', { scroll: false }));
        expect(currentSearch).toBe('view=agenda');

        // The address no longer names it; the message stays, and nothing loops.
        replaceMock.mockClear();
        rerender(
            <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
                <TenantProvider value={TENANT_CTX}>
                    <TooltipProvider>
                        <CalendarClient tenantSlug="acme-corp" />
                    </TooltipProvider>
                </TenantProvider>
            </SWRConfig>,
        );
        expect(document.getElementById('calendar-connect-outcome')).toHaveTextContent(
            (copy.outcome as Record<string, string>)[outcome],
        );
        await act(async () => {
            await new Promise((r) => setTimeout(r, 20));
        });
        expect(replaceMock).not.toHaveBeenCalled();
    });

    it('a value outside the set is removed and says nothing', async () => {
        currentSearch = 'calendar=%3Cscript%3E';
        mount();
        await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/t/acme-corp/calendar', { scroll: false }));
        expect(document.getElementById('calendar-connect-outcome')).toBeNull();
        expect(screen.queryByText('<script>')).toBeNull();
    });

    it('can be dismissed', async () => {
        currentSearch = 'calendar=connected';
        mount();
        const notice = await waitFor(() => {
            const el = document.getElementById('calendar-connect-outcome');
            if (!el) throw new Error('no notice');
            return el;
        });
        fireEvent.click(within(notice).getByRole('button'));
        await waitFor(() => expect(document.getElementById('calendar-connect-outcome')).toBeNull());
    });
});
