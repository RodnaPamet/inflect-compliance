/** @jest-environment jsdom */

/**
 * The reconciliation queue names its candidates, words its evidence and offers
 * every decision the usecase takes (#4871).
 *
 * Before: a candidate was a database id in a code font, signals and vetoes
 * were stored codes, a failed read said "Nothing to decide", and only Confirm
 * and Defer could be recorded — so a service account or a contractor came back
 * every cycle. Each test below drives the page the way a reviewer does.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

// ─── sonner shim: count the undo toasts the Confirm button raises ─────────
const customCalls: unknown[] = [];
jest.mock('sonner', () => ({
    toast: {
        custom: (factory: unknown) => {
            customCalls.push(factory);
            return customCalls.length;
        },
        dismiss: jest.fn(),
        success: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
    },
}));

// Stable references (see the facets suite for why an unstable `apiUrl` loops).
const API_URL = (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`;
const TENANT_HREF = (p: string) => `/t/acme${p}`;
const TENANT_CTX = {
    tenantSlug: 'acme',
    appPermissions: { identity_reconciliation: { confirm: true } },
};
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => API_URL,
    useTenantHref: () => TENANT_HREF,
    useTenantContext: () => TENANT_CTX,
}));

jest.mock('next/navigation', () => ({
    useParams: () => ({ connectionId: 'conn-1', tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
    useSearchParams: () => new URLSearchParams(window.location.search),
    usePathname: () => window.location.pathname,
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            return v
                .replace(PLURAL, (block: string, name: string, options: string) => {
                    if (!params || !(name in params)) return block;
                    const n = Number(params[name]);
                    const forms = new Map<string, string>();
                    for (const m of options.matchAll(/(=\d+|one|other)\s*\{([^{}]*)\}/g)) forms.set(m[1], m[2]);
                    const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                    return body === undefined ? block : body.split('#').join(String(n));
                })
                .replace(/\{(\w+)\}/g, (m: string, name: string) =>
                    params && name in params ? String(params[name]) : m,
                );
        };
        t.rich = t;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    const cache = new Map<string, ReturnType<typeof make>>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns)!;
        },
        useLocale: () => 'en',
    };
});

// The trail as text, so the connection's name in it can be asserted.
jest.mock('@/components/layout/PageBreadcrumbs', () => ({
    PageBreadcrumbs: ({ items }: { items: Array<{ label: string }> }) => (
        <nav data-testid="crumbs">{items.map((i) => i.label).join(' / ')}</nav>
    ),
}));

import ReconciliationQueuePage from '@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/reconciliation/page';

const en = require('../../messages/en.json');
const L = en.admin.integrations.legacyQueue;

const ROWS = [
    {
        accountKey: 'jdoe',
        outcome: 'AMBIGUOUS',
        reason: 'UNDECIDED',
        expiredAt: null,
        candidates: [
            {
                employeeId: 'emp-ana',
                score: 90,
                signals: [
                    { kind: 'EMAIL_EXACT', score: 60, evidence: null },
                    { kind: 'NAME_EXACT', score: 30, evidence: null },
                ],
                vetoes: [{ kind: 'EMPLOYEE_NUMBER_CONFLICT', detail: null }],
            },
            { employeeId: 'emp-gone', score: 20, signals: [], vetoes: [] },
        ],
    },
    { accountKey: 'svc-backup', outcome: 'UNMATCHED', reason: 'UNDECIDED', expiredAt: null, candidates: [] },
];
const PEOPLE = { 'emp-ana': { name: 'Ana Petrova', email: 'ana@acme.test' } };

let queueStatus = 200;
let calls: Array<{ path: string; method: string; body: unknown }> = [];

beforeEach(() => {
    customCalls.length = 0;
    calls = [];
    queueStatus = 200;
    TENANT_CTX.appPermissions.identity_reconciliation.confirm = true;
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/admin/integrations/conn-1/reconciliation');
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://test.local');
        const method = init?.method ?? 'GET';
        calls.push({ path: url.pathname, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        let status = 200;
        let body: unknown = {};
        if (url.pathname.endsWith('/executions')) {
            body = {
                connection: { id: 'conn-1', name: 'Payroll', provider: 'legacy-mcp', isEnabled: true, ownerUserId: null },
                executions: [
                    { id: 'exec-1', automationKey: 'legacy-mcp.reconcile', status: 'PASSED', executedAt: '2026-02-01T00:00:00.000Z' },
                ],
            };
        } else if (url.pathname.endsWith('/queue')) {
            status = queueStatus;
            body = status === 200 ? { rows: ROWS, people: PEOPLE } : { error: { message: 'boom' } };
        } else if (url.pathname.endsWith('/decide')) {
            body = { result: { ok: true } };
        }
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
});

const decideCalls = () => calls.filter((c) => c.path.endsWith('/decide'));

function rowOf(accountKey: string): HTMLElement {
    const cell = screen.getByText(accountKey);
    const row = cell.closest('tr');
    if (!row) throw new Error(`no row for ${accountKey}`);
    return row as HTMLElement;
}

it('names each candidate by HR name and email, never by its id', async () => {
    render(<ReconciliationQueuePage />);
    await screen.findByText('jdoe');

    expect(within(rowOf('jdoe')).getByText('Ana Petrova · ana@acme.test')).toBeTruthy();
    expect(screen.queryByText('emp-ana')).toBeNull();
    // The trail names the connection, from the executions read.
    expect(screen.getByTestId('crumbs').textContent).toContain('Payroll');
    expect(screen.getByText('2 accounts still need a decision')).toBeTruthy();
});

it('words every signal and veto in the evidence sheet, and names an unknown candidate as such', async () => {
    render(<ReconciliationQueuePage />);
    await screen.findByText('jdoe');

    await act(async () => {
        fireEvent.click(within(rowOf('jdoe')).getByRole('button', { name: L.review }));
    });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(new RegExp(`^${L.signalKind.EMAIL_EXACT} · 60`))).toBeTruthy();
    expect(within(dialog).getByText(new RegExp(`^${L.signalKind.NAME_EXACT} · 30`))).toBeTruthy();
    expect(within(dialog).getByText(`${L.sheetVetoes}: ${L.vetoKind.EMPLOYEE_NUMBER_CONFLICT}`)).toBeTruthy();
    expect(within(dialog).queryByText(/EMAIL_EXACT|EMPLOYEE_NUMBER_CONFLICT/)).toBeNull();
    // A candidate HR no longer holds reads as unknown, not as its id.
    expect(within(dialog).queryByText('emp-gone')).toBeNull();
    expect(within(dialog).getAllByText(new RegExp(L.unknownPerson)).length).toBeGreaterThan(0);
});

it('says the queue could not be read, rather than that there is nothing to decide', async () => {
    queueStatus = 500;
    render(<ReconciliationQueuePage />);

    await waitFor(() => expect(screen.getAllByText(L.loadError).length).toBeGreaterThan(0));
    expect(screen.queryByText(L.empty)).toBeNull();
});

it('offers the four answered decisions beside Confirm, and records one with its reason', async () => {
    render(<ReconciliationQueuePage />);
    await screen.findByText('svc-backup');

    await act(async () => {
        fireEvent.click(within(rowOf('svc-backup')).getByRole('button', { name: L.review }));
    });
    const dialog = await screen.findByRole('dialog');

    // No candidate, so no Confirm: the four that need an answer.
    for (const kind of ['MANUAL', 'NON_PERSON', 'EXTERNAL', 'ORPHAN'] as const) {
        expect(within(dialog).getByRole('radio', { name: new RegExp(L.decision[kind]) })).toBeTruthy();
    }
    expect(within(dialog).queryByRole('radio', { name: new RegExp(L.decision.CONFIRM) })).toBeNull();

    await act(async () => {
        fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(L.decision.ORPHAN) }));
    });
    const reason = dialog.querySelector('#legacy-decision-reason') as HTMLTextAreaElement;
    const submit = within(dialog).getByRole('button', { name: L.decideSubmit }) as HTMLButtonElement;

    // The route takes at least 10 characters, so 9 cannot be sent.
    fireEvent.change(reason, { target: { value: '123456789' } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(reason, { target: { value: 'Owner left in 2019; nobody claims it.' } });
    expect(submit.disabled).toBe(false);
    await act(async () => {
        fireEvent.click(submit);
    });

    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(decideCalls()[0].body).toEqual({
        connectionId: 'conn-1',
        accountKey: 'svc-backup',
        executionId: 'exec-1',
        action: { kind: 'ORPHAN', justification: 'Owner left in 2019; nobody claims it.' },
    });
});

it('offers Confirm in the sheet when there is a candidate to confirm', async () => {
    render(<ReconciliationQueuePage />);
    await screen.findByText('jdoe');
    await act(async () => {
        fireEvent.click(within(rowOf('jdoe')).getByRole('button', { name: L.review }));
    });
    const dialog = await screen.findByRole('dialog');
    for (const kind of ['CONFIRM', 'MANUAL', 'NON_PERSON', 'EXTERNAL', 'ORPHAN'] as const) {
        expect(within(dialog).getByRole('radio', { name: new RegExp(L.decision[kind]) })).toBeTruthy();
    }
});

it('a row Confirm waits for the undo window before it is sent', async () => {
    render(<ReconciliationQueuePage />);
    await screen.findByText('jdoe');

    await act(async () => {
        fireEvent.click(within(rowOf('jdoe')).getByRole('button', { name: L.actConfirm }));
    });

    // Queued, not sent: the toast is up and nothing has reached the route.
    expect(customCalls).toHaveLength(1);
    expect(decideCalls()).toHaveLength(0);

    await waitFor(() => expect(decideCalls()).toHaveLength(1), { timeout: 10_000 });
    expect((decideCalls()[0].body as { action: unknown }).action).toEqual({ kind: 'CONFIRM', employeeId: 'emp-ana' });
});

it('offers no decision to a viewer the decide routes refuse', async () => {
    TENANT_CTX.appPermissions.identity_reconciliation.confirm = false;
    render(<ReconciliationQueuePage />);
    await screen.findByText('jdoe');

    expect(within(rowOf('jdoe')).queryByRole('button', { name: L.actConfirm })).toBeNull();
    expect(within(rowOf('jdoe')).queryByRole('button', { name: L.actDefer })).toBeNull();

    await act(async () => {
        fireEvent.click(within(rowOf('jdoe')).getByRole('button', { name: L.review }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: L.decideSubmit })).toBeNull();
});
