/** @jest-environment jsdom */

/**
 * The Internal Audit hub (`AuditsClient`) — what it offers, and what it says.
 *
 * Every write on this page goes to `POST /audits` or `PUT /audits/{id}`, whose
 * usecases assert the coarse write tier (`assertCanWrite`) and nothing else.
 * So the page's write controls follow `canWrite`, the same value: a Reader, an
 * Auditor or an AI admin is shown the audit, not buttons the server refuses.
 *
 * Each case drives the rendered component and reads what is on screen or what
 * reached the wire — not the source.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: jest.fn(), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

// The repo-wide next-intl mock returns a fresh `t` per render, which loops any
// component whose effects depend on it. Real next-intl memoises; so does this.
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
            const str = typeof val === 'string' ? val : key;
            return params
                ? str.replace(/\{(\w+)(?:, number)?\}/g, (m, n) =>
                    Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : m)
                : str;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
        useFormatter: () => ({ dateTime: String, number: String, relativeTime: String, list: (l: string[]) => l.join(', ') }),
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
    };
});

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: () => null,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

let currentSearch = new URLSearchParams();
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), back: jest.fn(),
        refresh: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/audits',
    useSearchParams: () => currentSearch,
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { SWRConfig } from 'swr';
import { toast } from 'sonner';
import { AuditsClient } from '@/app/t/[tenantSlug]/(app)/audits/AuditsClient';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

type Role = 'EDITOR' | 'READER';

function tenantCtx(role: Role) {
    const canWrite = role === 'EDITOR';
    return {
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        tenantName: 'Acme',
        role,
        permissions: { canRead: true, canWrite, canAdmin: false, canAudit: false, canExport: true },
        appPermissions: getPermissionsForRole(role),
        modules: { processCanvas: false },
    };
}

const LIST_ROW = {
    id: 'audit-1',
    title: 'Q3 internal audit',
    status: 'PLANNED',
    _count: { checklist: 1, findings: 1 },
};

let detail: Record<string, unknown>;

function freshDetail() {
    return {
        id: 'audit-1',
        title: 'Q3 internal audit',
        status: 'PLANNED',
        auditScope: 'Access management',
        auditors: 'Jane Auditor, Raj Reviewer',
        checklist: [
            { id: 'item-1', prompt: 'Verify A.5.1 — policies exist', result: 'NOT_TESTED', notes: null },
        ],
        findings: [{ id: 'f-1', title: 'Stale access reviews', severity: 'HIGH' }],
    };
}

const TRANSLATIONS = {
    title: 'Audits', listDescription: '', newAudit: 'Audit', auditTitle: 'Title',
    auditors: 'Auditors', scope: 'Scope', createAudit: 'Create audit', cancel: 'Cancel',
    planned: 'Planned', inProgress: 'In progress', completed: 'Completed', cancelled: 'Cancelled',
    notTested: 'Not tested', pass: 'Pass', fail: 'Fail', checklist: 'Checklist',
    findingsTab: 'Findings', selectAudit: 'Select an audit',
};

const fetchMock = jest.fn();
/** The list GET's answer — a test can model an empty or a capped list. */
let listResponse: { rows: unknown[]; truncated: boolean };
/** The audit-cycle list — the page's only narrowing control is its picker. */
let cyclesResponse: unknown[];
/** Set by a test to make every PUT answer with this status and body. */
let putRefusal: { status: number; body: unknown } | null;

beforeEach(() => {
    currentSearch = new URLSearchParams();
    detail = freshDetail();
    listResponse = { rows: [LIST_ROW], truncated: false };
    cyclesResponse = [];
    putRefusal = null;
    (toast.error as jest.Mock).mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'PUT') {
            if (putRefusal) {
                const { status, body } = putRefusal;
                return Promise.resolve({ ok: false, status, json: async () => body } as Response);
            }
            return Promise.resolve({ ok: true, json: async () => ({ success: true }) } as Response);
        }
        if (/\/audits\/audit-1$/.test(u)) return Promise.resolve({ ok: true, json: async () => detail } as Response);
        if (u.includes('/audits/cycles')) return Promise.resolve({ ok: true, json: async () => cyclesResponse } as Response);
        if (u.includes('/frameworks')) return Promise.resolve({ ok: true, json: async () => [] } as Response);
        return Promise.resolve({ ok: true, json: async () => listResponse } as Response);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

async function flush() {
    await act(async () => {
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
}

async function renderHub(role: Role, initialAudits: unknown[] = [LIST_ROW]) {
    // A fresh SWR cache per render: the list key is the same in every test,
    // and a cache shared across tests would hand one test the last one's rows.
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TenantProvider value={tenantCtx(role)}>
                <AuditsClient
                    initialAudits={initialAudits as never}
                    tenantSlug="acme"
                    hasNis2={false}
                    canWrite={role === 'EDITOR'}
                    translations={TRANSLATIONS}
                />
            </TenantProvider>
        </SWRConfig>,
    );
    await flush();
}

/** Render the hub and open the audit's detail pane by clicking its row. */
async function openAudit(role: Role) {
    await renderHub(role);
    await act(async () => {
        fireEvent.click(screen.getAllByText('Q3 internal audit')[0]);
    });
    await flush();
}

/** The detail pane — scoped so the header's nav links cannot match. */
function pane(): HTMLElement {
    const heading = screen.getByRole('heading', { level: 2, name: 'Q3 internal audit' });
    return heading.closest('.animate-fadeIn') as HTMLElement;
}

describe('write controls follow the write tier the server asserts', () => {
    it('a writer is offered create, the status step, the result picker, Edit and Finding', async () => {
        await openAudit('EDITOR');
        expect(document.querySelector('#new-audit-btn')).not.toBeNull();
        const p = within(pane());
        expect(p.getByRole('button', { name: 'In progress' })).toBeTruthy();
        // The pane's only combobox is the checklist row's result picker.
        expect(p.getAllByRole('combobox')).toHaveLength(1);
        expect(document.querySelector('#edit-audit-btn')).not.toBeNull();
        expect(document.querySelector('#new-audit-finding-btn')).not.toBeNull();
    });

    it('a reader is shown the audit read-only: no create, no status step, no result picker', async () => {
        await openAudit('READER');
        expect(document.querySelector('#new-audit-btn')).toBeNull();
        const p = within(pane());
        expect(p.queryByRole('button', { name: 'In progress' })).toBeNull();
        expect(p.queryAllByRole('combobox')).toHaveLength(0);
        expect(document.querySelector('#edit-audit-btn')).toBeNull();
        expect(document.querySelector('#new-audit-finding-btn')).toBeNull();
        // The result is still stated — by the row's badge.
        expect(p.getByText('Not tested')).toBeTruthy();
        expect(p.getByText('Verify A.5.1 — policies exist')).toBeTruthy();
    });

    it('the empty state offers a reader no create action, and says who can create', async () => {
        listResponse = { rows: [], truncated: false };
        await renderHub('READER', []);
        expect(screen.getByText('No audits yet')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Audit' })).toBeNull();
        expect(screen.getByText('Owners, Admins and Editors can create audits.')).toBeTruthy();
    });

    it('the empty state still offers a writer the create action', async () => {
        listResponse = { rows: [], truncated: false };
        await renderHub('EDITOR', []);
        expect(screen.getAllByRole('button', { name: 'Audit' }).length).toBeGreaterThan(0);
        expect(screen.queryByText('Owners, Admins and Editors can create audits.')).toBeNull();
    });

    it('`?create=1` (the /audits/new shim) opens the create dialog for a writer only', async () => {
        currentSearch = new URLSearchParams('create=1');
        await renderHub('READER');
        expect(document.querySelector('#new-audit-form')).toBeNull();
    });

    it('`?create=1` still opens the create dialog for a writer', async () => {
        currentSearch = new URLSearchParams('create=1');
        await renderHub('EDITOR');
        expect(document.querySelector('#new-audit-form')).not.toBeNull();
    });
});

/** The sentence `assertCanWrite` refuses with, in the API's error envelope. */
const FORBIDDEN = {
    status: 403,
    body: { error: { code: 'FORBIDDEN', message: 'You do not have permission to modify records in this context.' } },
};

function errorToasts(): string[] {
    return (toast.error as jest.Mock).mock.calls.map(([m]) => String(m));
}

describe('a refused write says why', () => {
    it('a refused status change shows the server\'s reason, not the generic sentence', async () => {
        await openAudit('EDITOR');
        putRefusal = FORBIDDEN;
        await act(async () => {
            fireEvent.click(within(pane()).getByRole('button', { name: 'In progress' }));
        });
        await flush();
        expect(errorToasts()).toEqual([FORBIDDEN.body.error.message]);
    });

    it('a refused checklist result shows the server\'s reason', async () => {
        await openAudit('EDITOR');
        putRefusal = FORBIDDEN;
        await act(async () => { fireEvent.click(within(pane()).getByRole('combobox')); });
        const option = await screen.findByRole('option', { name: /^pass$/i });
        await act(async () => { fireEvent.click(option); });
        await flush();
        expect(errorToasts()).toEqual([FORBIDDEN.body.error.message]);
    });

    it('a refused edit shows the server\'s reason', async () => {
        await openAudit('EDITOR');
        putRefusal = FORBIDDEN;
        await act(async () => { fireEvent.click(document.querySelector('#edit-audit-btn')!); });
        await flush();
        await act(async () => {
            fireEvent.submit(document.querySelector('#edit-audit-form') as HTMLFormElement);
        });
        await flush();
        expect(errorToasts()).toEqual([FORBIDDEN.body.error.message]);
    });

    it('a refusal with no reason in the body falls back to the caller\'s own sentence', async () => {
        await openAudit('EDITOR');
        putRefusal = { status: 500, body: {} };
        await act(async () => {
            fireEvent.click(within(pane()).getByRole('button', { name: 'In progress' }));
        });
        await flush();
        expect(errorToasts()).toEqual(['Failed to update audit status.']);
    });
});
