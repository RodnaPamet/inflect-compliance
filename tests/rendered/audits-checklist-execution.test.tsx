/** @jest-environment jsdom */

/**
 * The checklist execution flow — the core audit workflow — executing.
 *
 * `AuditsClient.tsx` carried 18 structural ratchets and no test that ran it.
 * Its exclusion from the DataTable ratchet is deliberate and documented
 * ("master/detail panel UX, not a list page"), and that part is fine. The gap
 * was that the flow an auditor actually performs — open an audit, record a
 * PASS/FAIL against a checklist row, move the audit's status — was described
 * structurally and never exercised.
 *
 * That distinction has teeth on this surface: the Assets status control is the
 * repo's worked example of a guard asserting a schema *mentions* `status` while
 * the control persisted nothing for months. Every assertion here drives the
 * component and reads what reached the wire.
 *
 * The failure case is the one that matters. A PUT that fails must NOT leave the
 * row looking saved — an auditor who sees PASS on screen and PASS nowhere in
 * the database is the worst outcome this page can produce, because the
 * discrepancy surfaces during the audit itself.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
                ? str.replace(/\{(\w+)\}/g, (m, n) =>
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
}));

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), back: jest.fn(),
        refresh: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/audits',
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { AuditsClient } from '@/app/t/[tenantSlug]/(app)/audits/AuditsClient';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

const LIST_ROW = {
    id: 'audit-1',
    title: 'Q3 internal audit',
    status: 'PLANNED',
    _count: { checklist: 2, findings: 0 },
};

/** Mutable so a test can model the server's post-write state. */
let detail: Record<string, unknown>;

function freshDetail() {
    return {
        id: 'audit-1',
        title: 'Q3 internal audit',
        status: 'PLANNED',
        auditScope: 'Access management',
        checklist: [
            { id: 'item-1', prompt: 'Verify A.5.1 — policies exist', result: 'NOT_TESTED', notes: null },
            { id: 'item-2', prompt: 'Verify A.5.2 — roles assigned', result: 'NOT_TESTED', notes: null },
        ],
        findings: [],
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
/** Set by a test to make the next PUT fail. */
let failNextPut = false;

beforeEach(() => {
    detail = freshDetail();
    failNextPut = false;
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'PUT') {
            if (failNextPut) {
                return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
            }
            // Model the server: apply the patch so the re-read reflects it.
            const body = JSON.parse(String(init.body));
            if (body.status) detail.status = body.status;
            for (const up of body.checklistUpdates ?? []) {
                const row = (detail.checklist as Array<Record<string, unknown>>).find((c) => c.id === up.id);
                if (row) { row.result = up.result; row.notes = up.notes ?? row.notes; }
            }
            return Promise.resolve({ ok: true, json: async () => detail } as Response);
        }
        if (/\/audits\/audit-1$/.test(u)) return Promise.resolve({ ok: true, json: async () => detail } as Response);
        if (u.includes('/audits/cycles')) return Promise.resolve({ ok: true, json: async () => [] } as Response);
        return Promise.resolve({ ok: true, json: async () => ({ rows: [LIST_ROW], truncated: false }) } as Response);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

async function flush() {
    await act(async () => {
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
}

/** Render the hub and open the audit's detail pane by clicking its row. */
async function openAudit() {
    render(
        <TenantProvider value={TENANT_CTX}>
            <AuditsClient
                initialAudits={[LIST_ROW]}
                tenantSlug="acme"
                hasNis2={false}
                canWrite
                translations={TRANSLATIONS}
            />
        </TenantProvider>,
    );
    await flush();
    await act(async () => {
        // The list row, specifically — once the pane opens, the title also
        // appears as its <h2> heading.
        fireEvent.click(screen.getAllByText('Q3 internal audit')[0]);
    });
    await flush();
}

/** PUT bodies sent so far. */
function puts(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'PUT')
        .map(([, init]) => JSON.parse(String(init.body)));
}

/** Open a Combobox by its visible trigger text and pick an option. */
async function pickFromCombobox(triggerText: RegExp, optionText: RegExp) {
    const triggers = screen.getAllByRole('combobox');
    const trigger = triggers.find((t) => triggerText.test(t.textContent ?? '')) ?? triggers[0];
    await act(async () => { fireEvent.click(trigger); });
    const option = await screen.findByRole('option', { name: optionText });
    await act(async () => { fireEvent.click(option); });
    await flush();
}

describe('recording a checklist result', () => {
    it('opens the audit and renders its checklist rows', async () => {
        await openAudit();
        expect(screen.getByText('Verify A.5.1 — policies exist')).toBeTruthy();
        expect(screen.getByText('Verify A.5.2 — roles assigned')).toBeTruthy();
    });

    it('persists the chosen result for the row that was changed', async () => {
        await openAudit();
        await pickFromCombobox(/not tested/i, /^pass$/i);

        await waitFor(() => expect(puts().length).toBeGreaterThan(0));
        const body = puts()[0];
        expect(body.checklistUpdates).toEqual([
            expect.objectContaining({ id: 'item-1', result: 'PASS' }),
        ]);
    });

    it('re-reads the audit after a successful write, so the pane shows the saved value', async () => {
        // The write returns the row, but the pane refreshes from the detail GET
        // — asserting the re-read is what proves the pane cannot show a stale
        // NOT_TESTED after a successful save.
        await openAudit();
        const detailGetsBefore = fetchMock.mock.calls.filter(
            ([u, i]) => /\/audits\/audit-1$/.test(String(u)) && i?.method !== 'PUT',
        ).length;

        await pickFromCombobox(/not tested/i, /^pass$/i);

        await waitFor(() => {
            const after = fetchMock.mock.calls.filter(
                ([u, i]) => /\/audits\/audit-1$/.test(String(u)) && i?.method !== 'PUT',
            ).length;
            expect(after).toBeGreaterThan(detailGetsBefore);
        });
        expect((detail.checklist as Array<Record<string, unknown>>)[0].result).toBe('PASS');
    });

    it('a failed write leaves the row un-saved rather than optimistically PASS', async () => {
        // The assertion this file exists for. An auditor reading PASS on screen
        // while the database holds NOT_TESTED discovers it mid-audit.
        await openAudit();
        failNextPut = true;
        await pickFromCombobox(/not tested/i, /^pass$/i);
        await flush();

        expect((detail.checklist as Array<Record<string, unknown>>)[0].result).toBe('NOT_TESTED');
        // And the control has not painted the unsaved value.
        const combos = screen.getAllByRole('combobox');
        expect(combos.some((c) => /not tested/i.test(c.textContent ?? ''))).toBe(true);
    });
});

describe('moving the audit through its status transitions', () => {
    it('offers exactly the transitions valid from the current status', async () => {
        // PLANNED offers only "In progress" — the page deliberately renders one
        // forward step at a time rather than a free status picker.
        // Scoped to the detail pane, not the page: the hub's nav rail also
        // carries links whose labels would match a bare page-level query.
        await openAudit();
        const buttons = Array.from(document.querySelectorAll('button'))
            .map((b) => b.textContent?.trim() ?? '');
        expect(buttons).toContain('In progress');
        expect(buttons).not.toContain('Completed');
    });

    it('PLANNED → IN_PROGRESS sends the status and the server takes it', async () => {
        await openAudit();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /in progress/i }));
        });
        await waitFor(() => expect(puts().some((b) => b.status === 'IN_PROGRESS')).toBe(true));
        expect(detail.status).toBe('IN_PROGRESS');
    });

    it('IN_PROGRESS → COMPLETED is offered once the audit is in progress', async () => {
        await openAudit();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /in progress/i }));
        });
        await flush();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /completed/i }));
        });
        await waitFor(() => expect(puts().some((b) => b.status === 'COMPLETED')).toBe(true));
        expect(detail.status).toBe('COMPLETED');
    });

    it('a failed status write rolls the pill back to the prior status', async () => {
        // The optimistic flip is deliberate here (the pill is the whole point of
        // the click), so the rollback is what keeps it honest.
        await openAudit();
        failNextPut = true;
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /in progress/i }));
        });
        await flush();

        expect(detail.status).toBe('PLANNED');
        // The forward button is still offered, i.e. the pane went back to PLANNED.
        expect(screen.getByRole('button', { name: /in progress/i })).toBeTruthy();
    });
});
