/** @jest-environment jsdom */

/**
 * `/admin/notifications` — the page-level findings of #4469.
 *
 *   - A refused save no longer crashes the page. The 400 body (the error
 *     envelope) used to be written into `settings`, and the next render read
 *     `mutedInAppTypes` off it.
 *   - A failed load says so, with the server's reason and a retry, instead of
 *     leaving the skeleton up for ever.
 *   - The run-job buttons confirm in a dialog and report readable counts in a
 *     toast, never `confirm()`, `alert()` or raw JSON.
 *   - The Enabled/Disabled badge shows the SAVED state, not the unsaved switch.
 *   - No placeholder offers the deployment's unconfigured sender address.
 *   - The BCC note and the switch's help text name the emails they cover.
 *
 * The in-app preference list has its own file
 * (`admin-notification-preferences.test.tsx`).
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import { listInAppNotificationTypes } from '@/app-layer/notifications/agentic';
import { UNCONFIGURED_SENDER } from '@/lib/email/sender-identity';

// The run-job confirmation is a `<ConfirmDialog>`, and Modal reads the Next
// router — so the page now needs it mounted. Stable references, for the same
// reason as the tenant-context mock below.
const router = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() };
const searchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
    useRouter: () => router,
    usePathname: () => '/t/acme/admin/notifications',
    useSearchParams: () => searchParams,
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = ns.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en as unknown,
        );
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
        return (key: string, params?: Record<string, unknown>) => {
            let v = resolve(key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return v;
        };
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// Stable references — see the note in admin-notification-preferences.test.tsx:
// a fresh `apiUrl` per render re-runs the fetch effect on every render.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path}`;
    const permissions = { admin: { view: true, manage: true } };
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        usePermissions: () => permissions,
    };
});

const toast = {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    dismiss: jest.fn(),
};
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({ useToast: () => toast }));

// Desktop Dialog branch for the confirm: jsdom's matchMedia reports mobile,
// which mounts the Vaul drawer instead. Mocked at the module Modal imports.
jest.mock('@inflect/ui/components/ui/hooks/use-media-query', () => ({
    useMediaQuery: () => ({ device: 'desktop', width: 1024, height: 768, isMobile: false, isDesktop: true }),
}));

import NotificationSettingsPage from '@/app/t/[tenantSlug]/(app)/admin/notifications/page';

const en = require('../../messages/en.json');
const M = en.admin.notifications as Record<string, string>;

const SETTINGS = {
    enabled: true,
    defaultFromName: 'Acme GRC',
    defaultFromEmail: 'grc@acme.test',
    complianceMailbox: null as string | null,
    mutedInAppTypes: [] as string[],
};
const STATS = {
    last24h: { pending: 0, sent: 0, failed: 0 },
    last7d: { pending: 0, sent: 0, failed: 0 },
    last30d: { pending: 0, sent: 0, failed: 0 },
};

type Reply = { status: number; body: unknown };
interface Server {
    get: Reply[];
    put: Reply[];
    post: Reply[];
    calls: { method: string; url: string; body?: unknown }[];
}

function ok(body: unknown): Reply { return { status: 200, body }; }
function loaded(settings = SETTINGS): Reply {
    return ok({
        settings,
        stats: STATS,
        inAppTypes: listInAppNotificationTypes().map((i) => ({ ...i, muted: false })),
    });
}

/** Answers each method from its queue; the last reply of a queue repeats. */
function installServer(server: Omit<Server, 'calls'>): Server {
    const s: Server = { ...server, calls: [] };
    global.fetch = jest.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? 'GET';
        s.calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
        const queue = method === 'PUT' ? s.put : method === 'POST' ? s.post : s.get;
        const reply = queue.length > 1 ? queue.shift()! : queue[0];
        return {
            ok: reply.status >= 200 && reply.status < 300,
            status: reply.status,
            json: async () => reply.body,
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return s;
}

const confirmSpy = jest.fn(() => true);
const alertSpy = jest.fn();

beforeEach(() => {
    jest.clearAllMocks();
    window.confirm = confirmSpy;
    window.alert = alertSpy;
});
afterEach(() => cleanup());

async function renderLoaded() {
    render(<NotificationSettingsPage />);
    await waitFor(() => expect(screen.getByTestId('in-app-notification-types')).toBeTruthy());
}

const badgeText = () => screen.getByTestId('notifications-email-status').textContent;

describe('a refused save', () => {
    const REFUSED: Reply = {
        status: 400,
        body: {
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Invalid request payload',
                details: [{ path: ['defaultFromEmail'], code: 'invalid_format', message: 'Invalid email' }],
            },
        },
    };

    it('keeps the page and the form, and says the save was refused', async () => {
        installServer({ get: [loaded()], put: [REFUSED], post: [] });
        await renderLoaded();

        fireEvent.change(screen.getByLabelText(new RegExp(M.senderEmail)), { target: { value: 'not-an-address' } });
        fireEvent.click(screen.getByText(M.saveSettings));

        const alert = await screen.findByTestId('notification-settings-save-error');
        expect(alert.textContent).toContain(M.saveFailed);
        expect(alert.textContent).toContain('Invalid request payload');
        // The page did not crash: the in-app list (which read the field the
        // error body lacks) is still rendered, and the edit is still there.
        for (const info of listInAppNotificationTypes()) {
            expect(screen.getByTestId(`in-app-type-${info.type}`)).toBeTruthy();
        }
        expect((screen.getByLabelText(new RegExp(M.senderEmail)) as HTMLInputElement).value).toBe('not-an-address');
        // The field the server named is marked, and no success claim is made.
        expect(screen.getByText(M.emailInvalid)).toBeTruthy();
        expect(screen.queryByText(M.savedSuccess)).toBeNull();
    });

    it('a successful save after a refusal clears the error', async () => {
        installServer({ get: [loaded()], put: [REFUSED, ok({ ...SETTINGS, defaultFromName: 'Acme Security' })], post: [] });
        await renderLoaded();

        fireEvent.click(screen.getByText(M.saveSettings));
        await screen.findByTestId('notification-settings-save-error');
        fireEvent.click(screen.getByText(M.saveSettings));

        await screen.findByText(M.savedSuccess);
        expect(screen.queryByTestId('notification-settings-save-error')).toBeNull();
    });
});

describe('a failed load', () => {
    it('shows the failure and the server reason instead of the skeleton, and retries', async () => {
        const server = installServer({
            get: [
                { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Permission denied' } } },
                loaded(),
            ],
            put: [],
            post: [],
        });
        render(<NotificationSettingsPage />);

        const err = await screen.findByTestId('notification-settings-load-error');
        expect(err.textContent).toContain(M.loadFailed);
        expect(err.textContent).toContain('Permission denied');

        fireEvent.click(within(err).getByRole('button'));
        await waitFor(() => expect(screen.getByTestId('in-app-notification-types')).toBeTruthy());
        expect(server.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    });

    it('a network failure is a failed load too', async () => {
        global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
        render(<NotificationSettingsPage />);
        const err = await screen.findByTestId('notification-settings-load-error');
        expect(err.textContent).toContain(M.loadFailed);
    });
});

describe('the Enabled/Disabled badge', () => {
    it('shows the saved state until the switch is saved', async () => {
        installServer({ get: [loaded()], put: [ok({ ...SETTINGS, enabled: false })], post: [] });
        await renderLoaded();
        expect(badgeText()).toContain(M.enabled);

        const toggle = screen.getByRole('switch', { name: M.enableToggle });
        fireEvent.click(toggle);
        await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
        // Unsaved: the workspace is still sending email.
        expect(badgeText()).toContain(M.enabled);

        fireEvent.click(screen.getByText(M.saveSettings));
        await waitFor(() => expect(badgeText()).toContain(M.disabled));
    });
});

describe('the run-job buttons', () => {
    it('confirm in a dialog and report the outbox counts in a toast', async () => {
        const server = installServer({
            get: [loaded()],
            put: [],
            post: [ok({ success: true, jobType: 'processOutbox', stats: { sent: 3, failed: 1, skipped: 2 }, message: 'Outbox processed successfully' })],
        });
        await renderLoaded();

        fireEvent.click(screen.getByText(M.processOutbox));
        const dialog = await screen.findByRole('dialog');
        // Modal renders its title twice (an accessible DialogTitle and the visible heading).
        expect(within(dialog).getAllByText(M.runOutboxConfirmTitle).length).toBeGreaterThan(0);
        // Nothing has run yet.
        expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(0);

        await act(async () => { fireEvent.click(within(dialog).getByText(M.runOutboxConfirm)); });

        await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
        expect(server.calls.find((c) => c.method === 'POST')?.body).toEqual({ jobType: 'processOutbox' });
        const [title, opts] = toast.success.mock.calls[0];
        expect(title).toBe(M.outboxResultTitle);
        expect(opts.description).toBe('Sent: 3 · Failed: 1 · Skipped: 2');
        expect(opts.description).not.toMatch(/[{}]/);
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('report the daily sweep totals across its three thresholds', async () => {
        installServer({
            get: [loaded()],
            put: [],
            post: [ok({
                success: true,
                jobType: 'dailySweep',
                stats: {
                    sweeps: {
                        days30: { scanned: 5, tasksCreated: 2, skippedDuplicate: 1 },
                        days7: { scanned: 3, tasksCreated: 1, skippedDuplicate: 0 },
                        days1: { scanned: 1, tasksCreated: 0, skippedDuplicate: 1 },
                    },
                    outbox: { sent: 4, failed: 0, skipped: 0 },
                },
            })],
        });
        await renderLoaded();

        fireEvent.click(screen.getByText(M.dailySweep));
        const dialog = await screen.findByRole('dialog');
        await act(async () => { fireEvent.click(within(dialog).getByText(M.runSweepConfirm)); });

        await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
        const [title, opts] = toast.success.mock.calls[0];
        expect(title).toBe(M.sweepResultTitle);
        expect(opts.description).toBe(
            'Reminder tasks created: 3 · Already reminded: 2 · Emails sent: 4 · Failed: 0 · Skipped: 0',
        );
    });

    it('a refused job shows the server reason, never "[object Object]"', async () => {
        installServer({
            get: [loaded()],
            put: [],
            post: [{ status: 500, body: { error: { code: 'INTERNAL', message: '1 of 3 evidence sweeps failed' } } }],
        });
        await renderLoaded();

        fireEvent.click(screen.getByText(M.dailySweep));
        const dialog = await screen.findByRole('dialog');
        await act(async () => { fireEvent.click(within(dialog).getByText(M.runSweepConfirm)); });

        await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
        expect(toast.error.mock.calls[0][0]).toBe('1 of 3 evidence sweeps failed');
        expect(String(toast.error.mock.calls[0][0])).not.toContain('[object Object]');
        expect(toast.success).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('cancelling the dialog runs nothing', async () => {
        const server = installServer({ get: [loaded()], put: [], post: [ok({})] });
        await renderLoaded();

        fireEvent.click(screen.getByText(M.processOutbox));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByText(en.common.cancel));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });
});

describe('the settings form text', () => {
    it('never offers the unconfigured deployment sender as a placeholder', async () => {
        installServer({ get: [loaded()], put: [], post: [] });
        await renderLoaded();
        for (const input of screen.getAllByRole('textbox')) {
            expect(input.getAttribute('placeholder') ?? '').not.toContain(UNCONFIGURED_SENDER);
        }
    });

    it('says which emails the BCC copies and which the switch stops', async () => {
        installServer({ get: [loaded()], put: [], post: [] });
        await renderLoaded();
        // The owner decision of 2026-10-29, as the page states it: the digest
        // and scheduled reports are covered; invitations are not. Read off
        // the RENDERED text, so a page that stopped showing either line fails.
        const bcc = screen.getByText(M.bccNote).textContent ?? '';
        const help = screen.getByText(M.enableToggleHelp).textContent ?? '';
        expect(bcc).toMatch(/compliance digest/);
        expect(bcc).toMatch(/risk report/);
        expect(bcc).toMatch(/Invitations and account emails are not copied/);
        expect(bcc).not.toMatch(/^All outbound emails/);
        expect(help).toMatch(/compliance digest/);
        expect(help).toMatch(/risk report/);
        expect(help).toMatch(/Invitations to join the workspace and account emails/);
    });
});
