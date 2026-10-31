/** @jest-environment jsdom */

/**
 * #4824 — the Trust Center admin page publishes what the owner sees, says what
 * it refuses, and lets an administrator deny a request, issue a new link and
 * remove a document.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        success: (...a: unknown[]) => toastSuccess(...a),
        error: (...a: unknown[]) => toastError(...a),
        info: jest.fn(), warning: jest.fn(), dismiss: jest.fn(), custom: jest.fn(), message: jest.fn(), loading: jest.fn(),
    }),
}));

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            if (typeof val !== 'string') return key;
            return val.replace(/\{(\w+)\}/g, (m: string, name: string) =>
                params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m,
            );
        };
        t.has = (k: string) => typeof lookup(ns, k) === 'string';
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/admin/trust-center',
    useSearchParams: () => new URLSearchParams(),
}));

import { SWRConfig } from 'swr';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';
import { TrustCenterAdminClient } from '@/app/t/[tenantSlug]/(app)/admin/trust-center/TrustCenterAdminClient';

const en = jest.requireActual('../../messages/en.json');
const T = en.admin.trustCenter;
const G = T.gated;

type Reply = { status?: number; body: unknown };
type Route = (url: string, init?: RequestInit) => Reply | undefined;
let routes: Route[] = [];
const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const r of routes) {
        const reply = r(String(url), init);
        if (reply) {
            const status = reply.status ?? 200;
            return { ok: status < 400, status, json: async () => reply.body } as unknown as Response;
        }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } as unknown as Response;
});
const on = (method: string, re: RegExp, reply: Reply): Route => (u, i) =>
    (i?.method ?? 'GET') === method && re.test(u) ? reply : undefined;
const calls = (method: string, re: RegExp) =>
    fetchMock.mock.calls.filter(([u, i]) => ((i as RequestInit | undefined)?.method ?? 'GET') === method && re.test(String(u)));

const TENANT = {
    userId: 'u-1', tenantId: 't-1', tenantSlug: 'acme', tenantName: 'Acme', role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: false },
};

const SAVED = {
    slug: 'acme', enabled: false, indexable: false, displayName: 'Acme', tagline: null, postureSummary: null,
    securityContact: null, publishedFrameworks: [{ key: 'SOC 2', statusLabel: 'Type II' }], publishedDocuments: [] as { label: string; url: string }[],
};

const REQUEST = {
    id: 'req-1', requesterName: 'Grace Hopper', requesterEmail: 'grace@navy.example', company: null,
    status: 'REQUESTED', ndaSignedAt: null, expiresAt: null, downloadedAt: null,
    createdAt: '2026-10-30T00:00:00.000Z', document: { label: 'SOC 2 Type II' },
};

function mount(initial = SAVED, extra: Route[] = [], publicOrigin: string | null = 'https://grc.acme.test') {
    routes = [
        ...extra,
        on('GET', /\/admin\/trust-center\/documents$/, { body: { documents: [] } }),
        on('GET', /\/admin\/trust-center\/requests$/, { body: { requests: [] } }),
    ];
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT}>
                <TooltipProvider>
                    <TrustCenterAdminClient tenantSlug="acme" initial={initial} canPublish publicOrigin={publicOrigin} />
                </TooltipProvider>
            </TenantProvider>
        </SWRConfig>,
    );
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;
/** The message of every toast shown; the second argument is the toast's options. */
const said = (fn: jest.Mock) => fn.mock.calls.map((c) => c[0]);

beforeEach(() => {
    routes = [];
    fetchMock.mockClear();
    toastSuccess.mockReset();
    toastError.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

describe('publishing what the owner sees', () => {
    it('says nothing about unsaved edits until there are some', () => {
        mount();
        expect(document.getElementById('trust-unsaved-note')).toBeNull();
        fireEvent.change(screen.getByDisplayValue('Acme'), { target: { value: 'Acme Inc.' } });
        expect(byId('trust-unsaved-note')).toHaveTextContent(T.unsavedDraft);
    });

    it('saves the draft before it publishes, and publishes only once the save is taken', async () => {
        mount(SAVED, [
            on('PUT', /\/admin\/trust-center$/, { body: { ...SAVED, displayName: 'Acme Inc.' } }),
            on('POST', /\/admin\/trust-center\/enable$/, { body: { enabled: true } }),
        ]);
        fireEvent.change(screen.getByDisplayValue('Acme'), { target: { value: 'Acme Inc.' } });
        fireEvent.click(byId('trust-publish'));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(T.confirmSavesFirst);
        await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: T.confirmLabel })); });

        await waitFor(() => expect(calls('POST', /\/enable$/)).toHaveLength(1));
        const order = fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit | undefined)?.method ?? 'GET'} ${u}`)
            .filter((c) => c.startsWith('PUT') || c.startsWith('POST'));
        expect(order).toEqual(['PUT /api/t/acme/admin/trust-center', 'POST /api/t/acme/admin/trust-center/enable']);
        expect(JSON.parse(String((calls('PUT', /trust-center$/)[0][1] as RequestInit).body)).displayName).toBe('Acme Inc.');
    });

    it('publishes nothing when the save is refused, and says why', async () => {
        mount(SAVED, [
            on('PUT', /\/admin\/trust-center$/, { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Give the trust center a display name.' } } }),
        ]);
        fireEvent.change(screen.getByDisplayValue('Acme'), { target: { value: 'Acme Inc.' } });
        fireEvent.click(byId('trust-publish'));
        const dialog = await screen.findByRole('dialog');
        await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: T.confirmLabel })); });
        await waitFor(() => expect(said(toastError)).toContain('Give the trust center a display name.'));
        expect(calls('POST', /\/enable$/)).toHaveLength(0);
    });
});

describe('rows the save would have dropped', () => {
    it('marks a half-filled framework row and will not save', () => {
        mount();
        fireEvent.change(byId('trust-fw-status-0'), { target: { value: '' } });
        expect(byId('trust-fw-error-0')).toHaveTextContent(T.rowIncompleteFramework);
        expect(byId('trust-save')).toBeDisabled();
        expect(byId('trust-publish')).toBeDisabled();
    });

    it('marks a document address the server would refuse', () => {
        mount({ ...SAVED, publishedDocuments: [{ label: 'Whitepaper', url: 'https://acme.test/w.pdf' }] });
        fireEvent.change(byId('trust-doc-url-0'), { target: { value: 'acme.test/w.pdf' } });
        expect(byId('trust-doc-error-0')).toHaveTextContent(T.rowBadUrl);
        expect(byId('trust-save')).toBeDisabled();
    });

    it("shows the server's reason when a save is refused", async () => {
        mount(SAVED, [
            on('PUT', /\/admin\/trust-center$/, { status: 400, body: { error: { message: 'The address of "Whitepaper" must be a full web address starting with https:// or http://.' } } }),
        ]);
        await act(async () => { fireEvent.click(byId('trust-save')); });
        expect(said(toastError)).toContain('The address of "Whitepaper" must be a full web address starting with https:// or http://.');
    });

    it('says only that it failed when the server faults', async () => {
        mount(SAVED, [on('PUT', /\/admin\/trust-center$/, { status: 500, body: { error: { message: 'internal' } } })]);
        await act(async () => { fireEvent.click(byId('trust-save')); });
        expect(said(toastError)).toContain(T.toastSaveFailed);
    });
});

describe('the public address', () => {
    it('is a link with a copy button, at the configured origin', () => {
        mount();
        const link = byId('trust-public-link');
        expect(link).toHaveAttribute('href', '/trust/acme');
        expect(link).toHaveTextContent('https://grc.acme.test/trust/acme');
        expect(within(byId('trust-public-address')).getByRole('button', { name: T.copyAddress })).toBeInTheDocument();
        expect(byId('trust-public-address')).toHaveTextContent(T.notPublishedNote);
    });

    it('falls back to the browser origin with none configured', () => {
        mount(SAVED, [], null);
        expect(byId('trust-public-link')).toHaveTextContent(`${window.location.origin}/trust/acme`);
    });

    it('indexing is a checkbox control, not a raw input', () => {
        mount();
        expect(document.querySelector('input[type="checkbox"]')).toBeNull();
        expect(byId('trust-indexable')).toHaveAttribute('role', 'checkbox');
    });

    it('speaks plainly', () => {
        mount();
        expect(document.body.textContent).not.toMatch(/\bOFF\b|\bOWNER\b|PUBLIC/);
    });
});

describe('requests and documents', () => {
    const waitForId = (id: string) =>
        waitFor(() => {
            const el = document.getElementById(id);
            if (!el) throw new Error(`no #${id}`);
            return el;
        });

    it('a waiting request can be denied', async () => {
        mount(SAVED, [
            on('GET', /\/admin\/trust-center\/requests$/, { body: { requests: [REQUEST] } }),
            on('POST', /\/requests\/req-1\/deny$/, { body: { requestId: 'req-1' } }),
        ]);
        const deny = await waitForId('trust-deny-req-1');
        await act(async () => { fireEvent.click(deny); });
        expect(calls('POST', /\/requests\/req-1\/deny$/)).toHaveLength(1);
        expect(said(toastSuccess)).toContain(G.denied);
    });

    it('an approved request offers a new link, which says it replaces the old', async () => {
        mount(SAVED, [
            on('GET', /\/admin\/trust-center\/requests$/, {
                body: { requests: [{ ...REQUEST, status: 'APPROVED', expiresAt: '2026-01-01T00:00:00.000Z' }] },
            }),
            on('POST', /\/requests\/req-1\/approve$/, { body: { requestId: 'req-1', downloadToken: 'ictc_new' } }),
        ]);
        const row = await waitForId('trust-request-row-req-1');
        expect(row).toHaveTextContent('Link expired');
        expect(document.getElementById('trust-deny-req-1')).toBeNull();
        await act(async () => { fireEvent.click(byId('trust-reissue-req-1')); });
        await waitForId('trust-issued-link');
        expect(byId('trust-issued-replaced')).toHaveTextContent(G.linkReplaced);
    });

    it('a denied request offers nothing', async () => {
        mount(SAVED, [on('GET', /\/admin\/trust-center\/requests$/, { body: { requests: [{ ...REQUEST, status: 'DENIED' }] } })]);
        const row = await waitForId('trust-request-row-req-1');
        expect(within(row).queryByRole('button')).toBeNull();
    });

    it('removing a document waits out the undo window before the DELETE', async () => {
        mount(SAVED, [
            on('GET', /\/admin\/trust-center\/documents$/, {
                body: { documents: [{ id: 'd-1', label: 'Pen test', gated: true, createdAt: '2026-10-01T00:00:00.000Z' }] },
            }),
            on('DELETE', /\/admin\/trust-center\/documents\/d-1$/, { body: { documentId: 'd-1' } }),
        ]);
        const remove = await waitForId('trust-gated-remove-d-1');
        jest.useFakeTimers();
        try {
            fireEvent.click(remove);
            await act(async () => { await jest.advanceTimersByTimeAsync(10); });
            expect(document.getElementById('trust-gated-row-d-1')).toBeNull();
            expect(calls('DELETE', /documents\/d-1$/)).toHaveLength(0);
            await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
            expect(calls('DELETE', /documents\/d-1$/)).toHaveLength(1);
        } finally {
            jest.useRealTimers();
        }
    });
});
