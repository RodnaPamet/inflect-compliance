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
 *
 * A completed or cancelled audit is read-only (#4531): the last block holds
 * what the pane offers then, and what it says when the server refuses.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

import { toast } from 'sonner';
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
    modules: { processCanvas: false },
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
            { id: 'item-2', prompt: 'Verify A.5.2 — roles assigned', result: 'NOT_TESTED', notes: 'Sampled 5 of 40 role assignments' },
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
/** Set by a test to answer the next PUT with this refusal. */
let refuseNextPut: { status: number; body: unknown } | null = null;

beforeEach(() => {
    detail = freshDetail();
    failNextPut = false;
    refuseNextPut = null;
    (toast.error as jest.Mock).mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'PUT') {
            if (failNextPut) {
                return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
            }
            if (refuseNextPut) {
                const r = refuseNextPut;
                refuseNextPut = null;
                return Promise.resolve({ ok: false, status: r.status, json: async () => r.body } as Response);
            }
            // Model the server: apply the patch so the re-read reflects it.
            // Notes follow `updateAudit` + `AuditRepository.updateChecklistItem`
            // exactly: an absent `notes` leaves the column alone, and ANY string
            // — the empty one included — overwrites it. (This mock used to keep
            // the old note on `''`, which is how it hid the erasure.)
            const body = JSON.parse(String(init.body));
            if (body.status) detail.status = body.status;
            for (const up of body.checklistUpdates ?? []) {
                const row = (detail.checklist as Array<Record<string, unknown>>).find((c) => c.id === up.id);
                if (row) {
                    row.result = up.result;
                    if (up.notes !== undefined) row.notes = up.notes;
                }
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
async function openAudit(status?: string) {
    if (status) detail.status = status;
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

    it('changing a result leaves the item\'s note alone', async () => {
        // The page cannot write a note, so a note on a row came from the API —
        // and the first result change on the page used to send `notes: ''`,
        // which the server stores as given.
        await openAudit();
        expect(screen.getByText('Sampled 5 of 40 role assignments')).toBeTruthy();

        const triggers = screen.getAllByRole('combobox');
        const rowTwo = screen.getByText('Verify A.5.2 — roles assigned').closest('div.rounded-lg') as HTMLElement;
        const trigger = triggers.find((t) => rowTwo.contains(t))!;
        await act(async () => { fireEvent.click(trigger); });
        const option = await screen.findByRole('option', { name: /^pass$/i });
        await act(async () => { fireEvent.click(option); });
        await flush();

        await waitFor(() => expect(puts().length).toBeGreaterThan(0));
        const [update] = puts()[0].checklistUpdates as Array<Record<string, unknown>>;
        expect(update).toEqual({ id: 'item-2', result: 'PASS' });
        expect((detail.checklist as Array<Record<string, unknown>>)[1].notes).toBe('Sampled 5 of 40 role assignments');
        await waitFor(() => expect(screen.getByText('Sampled 5 of 40 role assignments')).toBeTruthy());
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
    /** The status-move buttons the pane offers, in order. */
    function statusButtons(): string[] {
        return ['#audit-status-forward-btn', '#audit-status-back-btn', '#cancel-audit-btn']
            .map((sel) => document.querySelector(sel)?.textContent?.trim())
            .filter((t): t is string => Boolean(t));
    }

    it.each([
        // One step forward, one step back, and Cancel while the audit is not
        // yet done — never a free status picker.
        ['PLANNED', ['In progress', 'Cancel audit']],
        ['IN_PROGRESS', ['Completed', 'Back to Planned', 'Cancel audit']],
        ['COMPLETED', ['Back to In Progress']],
        ['CANCELLED', []],
    ])('from %s the pane offers %j', async (status, expected) => {
        detail.status = status;
        await openAudit();
        expect(statusButtons()).toEqual(expected);
    });

    it('IN_PROGRESS → back to PLANNED sends the status and the server takes it', async () => {
        detail.status = 'IN_PROGRESS';
        await openAudit();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Back to Planned' }));
        });
        await waitFor(() => expect(puts().some((b) => b.status === 'PLANNED')).toBe(true));
        expect(detail.status).toBe('PLANNED');
        expect(statusButtons()).toEqual(['In progress', 'Cancel audit']);
    });

    it('COMPLETED → back to IN_PROGRESS sends the status and the server takes it', async () => {
        detail.status = 'COMPLETED';
        await openAudit();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Back to In Progress' }));
        });
        await waitFor(() => expect(puts().some((b) => b.status === 'IN_PROGRESS')).toBe(true));
        expect(detail.status).toBe('IN_PROGRESS');
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

describe('cancelling an audit', () => {
    async function openCancelDialog() {
        await openAudit();
        await act(async () => {
            fireEvent.click(document.querySelector('#cancel-audit-btn')!);
        });
        await flush();
        return screen.getByRole('dialog');
    }

    it('asks first, and keeping the audit sends nothing', async () => {
        const dialog = await openCancelDialog();
        expect(dialog.textContent).toContain('Cancel this audit?');
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Keep audit' }));
        });
        await flush();
        expect(puts()).toHaveLength(0);
        expect(detail.status).toBe('PLANNED');
    });

    it('confirming sends CANCELLED, and a cancelled audit offers no further move', async () => {
        const dialog = await openCancelDialog();
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel audit' }));
        });
        await waitFor(() => expect(puts().some((b) => b.status === 'CANCELLED')).toBe(true));
        expect(detail.status).toBe('CANCELLED');
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(document.querySelector('#audit-status-forward-btn')).toBeNull();
        expect(document.querySelector('#cancel-audit-btn')).toBeNull();
    });

    it('a refused cancel keeps the dialog open and the audit where it was', async () => {
        const dialog = await openCancelDialog();
        failNextPut = true;
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel audit' }));
        });
        await flush();
        expect(detail.status).toBe('PLANNED');
        expect(screen.getByRole('dialog')).toBeTruthy();
    });
});

/**
 * A completed or cancelled audit is read-only (#4531, owner decision
 * 2026-10-30): no Edit, no result pickers, no new finding, and a notice that
 * says why. A completed one keeps its move back to In Progress, which is how it
 * is changed. The server refuses the same writes; the page says so in the
 * viewer's language when it does.
 */
describe('a completed or cancelled audit is read-only', () => {
    const EN = jest.requireActual('../../messages/en.json') as {
        audits: { detail: Record<string, string>; list: Record<string, string> };
    };
    const resultPickers = () =>
        screen.queryAllByRole('combobox').filter((c) => /^Result for /.test(c.getAttribute('aria-label') ?? ''));

    it('an open audit names each result picker by its item', async () => {
        await openAudit('IN_PROGRESS');
        // The name rides `buttonProps`, where the Combobox reads it; a
        // top-level `aria-label` was ignored.
        expect(
            screen.getByRole('combobox', { name: 'Result for Verify A.5.1 — policies exist' }),
        ).toBeTruthy();
        expect(resultPickers()).toHaveLength(2);
        expect(document.querySelector('#edit-audit-btn')).not.toBeNull();
        expect(document.querySelector('#new-audit-finding-btn')).not.toBeNull();
        expect(document.querySelector('#audit-read-only-notice')).toBeNull();
    });

    it('a COMPLETED audit offers no edit, no picker and no finding — only the move back', async () => {
        await openAudit('COMPLETED');
        expect(resultPickers()).toHaveLength(0);
        expect(document.querySelector('#edit-audit-btn')).toBeNull();
        expect(document.querySelector('#new-audit-finding-btn')).toBeNull();
        expect(document.querySelector('#audit-read-only-notice')?.textContent).toContain(
            EN.audits.detail.readOnlyCompleted,
        );

        await act(async () => {
            fireEvent.click(document.querySelector('#audit-status-back-btn')!);
        });
        await waitFor(() => expect(puts()).toEqual([{ status: 'IN_PROGRESS' }]));
        // Reopened, it is editable again.
        await waitFor(() => expect(resultPickers()).toHaveLength(2));
        expect(document.querySelector('#audit-read-only-notice')).toBeNull();
    });

    it('a CANCELLED audit offers nothing at all, and says so', async () => {
        await openAudit('CANCELLED');
        expect(resultPickers()).toHaveLength(0);
        for (const id of ['#edit-audit-btn', '#new-audit-finding-btn', '#audit-status-forward-btn', '#audit-status-back-btn', '#cancel-audit-btn']) {
            expect({ id, present: document.querySelector(id) !== null }).toEqual({ id, present: false });
        }
        expect(document.querySelector('#audit-read-only-notice')?.textContent).toContain(
            EN.audits.detail.readOnlyCancelled,
        );
        // The result is still shown, as a badge.
        expect(screen.getAllByText('Not tested').length).toBeGreaterThan(0);
    });

    it('a write the server refuses because the audit closed meanwhile says so in the page’s words', async () => {
        await openAudit('IN_PROGRESS');
        refuseNextPut = {
            status: 409,
            body: {
                error: {
                    code: 'CONFLICT',
                    message: 'This audit is cancelled and can no longer be changed.',
                    details: { reason: 'AUDIT_CANCELLED_READ_ONLY' },
                },
            },
        };
        await pickFromCombobox(/not tested/i, /^pass$/i);
        await waitFor(() => expect((toast.error as jest.Mock).mock.calls.map((c) => c[0])).toContain(EN.audits.detail.readOnlyCancelled));
    });
});

/**
 * Closing the New audit form after typing asks in a dialog, not the browser's
 * own `confirm()` (#4531), and the close waits for the answer.
 */
describe('the New audit form asks before discarding what was typed', () => {
    async function openTypedForm() {
        await openAudit();
        await act(async () => {
            fireEvent.click(document.querySelector('#new-audit-btn')!);
        });
        await flush();
        await act(async () => {
            fireEvent.change(document.querySelector('#audit-title-input')!, { target: { value: 'Draft audit' } });
        });
        await flush();
    }
    const cancelForm = async () => {
        await act(async () => {
            fireEvent.click(document.querySelector('#new-audit-cancel-btn')!);
        });
        await flush();
    };

    it('keeping the draft leaves the form open with what was typed', async () => {
        const confirmSpy = jest.spyOn(window, 'confirm');
        await openTypedForm();
        await cancelForm();
        expect(screen.getAllByText('Discard audit?').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Any details you entered will be lost.').length).toBeGreaterThan(0);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
        });
        await flush();
        expect((document.querySelector('#audit-title-input') as HTMLInputElement).value).toBe('Draft audit');
        expect(confirmSpy).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
    });

    it('discarding closes the form', async () => {
        await openTypedForm();
        await cancelForm();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
        });
        await waitFor(() => expect(document.querySelector('#audit-title-input')).toBeNull());
    });
});
