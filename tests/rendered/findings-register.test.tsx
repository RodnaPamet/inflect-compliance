/**
 * The Findings register (#4461), mounted with what the server page passes.
 *
 * - The "Finding" button and the per-row status actions are offered only to a
 *   role with the coarse write tier: `createFinding` and `updateFinding` both
 *   `assertCanWrite` and nothing more, so a Reader, Auditor or AI admin was
 *   shown both and refused.
 * - A refused status change says why. It used to flip the badge and flip it
 *   back with nothing said.
 * - The table has no bulk actions, so it shows no select column.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(60_000);

// `computePermissions` lives beside the server-side tenant resolver, which
// imports the Prisma client; the role ladder itself needs none of it.
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: {} }),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    s = s.replace(new RegExp(`\\{${p}(, number)?\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockNav = {
    searchParams: new URLSearchParams(),
    router: {
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    },
};
jest.mock('next/navigation', () => {
    return {
        useRouter: () => mockNav.router,
        usePathname: () => '/t/acme/findings',
        useSearchParams: () => mockNav.searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({ useToast: () => mockToast }));

import type { Role } from '@prisma/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FindingsClient } from '@/app/t/[tenantSlug]/(app)/findings/FindingsClient';
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole } from '@/lib/permissions';

const en = require('../../messages/en.json');
const F = en.findings;

type Props = React.ComponentProps<typeof FindingsClient>;
type Row = Props['initialFindings'][number];

const ROW: Row = {
    id: 'finding-1',
    title: 'Access reviews not performed quarterly',
    severity: 'HIGH',
    type: 'NONCONFORMITY',
    status: 'OPEN',
    owner: null,
    assignee: null,
    control: null,
    audit: null,
    _count: { riskLinks: 0 },
};

const TRANSLATIONS: Props['translations'] = {
    title: F.title,
    listDescription: F.listDescription,
    open: F.open,
    newFinding: F.newFinding,
    findingTitle: F.findingTitle,
    severity: F.severity,
    type: F.type,
    owner: F.owner,
    status: F.status,
    description: F.description,
    dueDate: F.dueDate,
    createFinding: F.createFinding,
    noFindings: F.noFindings,
    low: F.low,
    medium: F.medium,
    high: F.high,
    critical: F.critical,
    nonconformity: F.nonconformity,
    observation: F.observation,
    opportunity: F.opportunity,
    inProgress: F.inProgress,
    readyForVerification: F.readyForVerification,
    closed: F.closed,
    cancel: en.common.cancel,
    actions: en.common.actions,
};

type FetchHandler = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;
let handler: FetchHandler = () => undefined;
const calls: Array<{ url: string; method: string; body?: unknown }> = [];

beforeEach(() => {
    calls.length = 0;
    handler = () => undefined;
    mockNav.searchParams = new URLSearchParams();
    Object.values(mockNav.router).forEach((fn) => fn.mockReset());
    Object.values(mockToast).forEach((fn) => fn.mockReset());
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const custom = handler(url, init);
        const { status, body } = custom ?? {
            status: 200,
            body: /\/findings(\?|$)/.test(url) ? { rows: [ROW], truncated: false } : [],
        };
        return Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(body),
        });
    }) as unknown as typeof fetch;
});

/**
 * The two write props as the page computes them (#4535): the `findings.*` key
 * the route asks AND the coarse tier the usecase asserts. `keys` overrides the
 * role's default findings keys, standing in for a custom role.
 */
function abilitiesFor(role: Role, keys?: Partial<{ create: boolean; edit: boolean }>) {
    const coarse = computePermissions(role).canWrite;
    const findings = { ...getPermissionsForRole(role).findings, ...keys };
    return { canCreate: coarse && findings.create, canEdit: coarse && findings.edit };
}

function mount(role: Role, rows: Row[] = [ROW], keys?: Partial<{ create: boolean; edit: boolean }>) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TooltipProvider>
                <FindingsClient
                    initialFindings={rows}
                    tenantSlug="acme"
                    {...abilitiesFor(role, keys)}
                    translations={TRANSLATIONS}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

const table = () => screen.getByTestId('findings-table');
const createButton = () => screen.queryByRole('button', { name: F.newFinding });

describe('the register offers writes to the roles the server lets write', () => {
    it.each<Role>(['OWNER', 'ADMIN', 'EDITOR'])('%s sees the Finding button and the status action', async (role) => {
        mount(role);
        await screen.findByText(ROW.title);
        expect(createButton()).toBeInTheDocument();
        expect(within(table()).getByRole('button', { name: F.inProgress })).toBeInTheDocument();
    });

    it.each<Role>(['READER', 'AUDITOR', 'AI_ADMIN'])('%s sees neither', async (role) => {
        mount(role);
        await screen.findByText(ROW.title);
        expect(createButton()).toBeNull();
        expect(within(table()).queryByRole('button', { name: F.inProgress })).toBeNull();
        // The column that held them is gone rather than left empty.
        expect(within(table()).queryByText(en.common.actions)).toBeNull();
    });

    // #4535 — a custom role on an EDITOR base can hold one findings key and
    // not the other; each write follows its own key.
    it('a custom role without findings.create keeps the status actions but no Finding button', async () => {
        mount('EDITOR', [ROW], { create: false });
        await screen.findByText(ROW.title);
        expect(createButton()).toBeNull();
        expect(within(table()).getByRole('button', { name: F.inProgress })).toBeInTheDocument();
    });

    it('a custom role without findings.edit keeps the Finding button but no status actions', async () => {
        mount('EDITOR', [ROW], { edit: false });
        await screen.findByText(ROW.title);
        expect(createButton()).toBeInTheDocument();
        expect(within(table()).queryByRole('button', { name: F.inProgress })).toBeNull();
    });

    it('a findings key alone does not offer a write the coarse tier refuses', async () => {
        mount('READER', [ROW], { create: true, edit: true });
        await screen.findByText(ROW.title);
        expect(createButton()).toBeNull();
        expect(within(table()).queryByRole('button', { name: F.inProgress })).toBeNull();
    });
});

describe('a refused status change says why', () => {
    it("toasts the server's reason and puts the status back", async () => {
        const REFUSAL = 'Finding not found';
        handler = (url, init) =>
            init?.method === 'PUT' && url.endsWith('/findings/finding-1')
                ? { status: 404, body: { error: { code: 'NOT_FOUND', message: REFUSAL } } }
                : undefined;
        mount('EDITOR');
        const action = await within(table()).findByRole('button', { name: F.inProgress });
        await act(async () => {
            fireEvent.click(action);
        });
        await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(REFUSAL));
        expect(calls.some((c) => c.method === 'PUT' && (c.body as { status?: string })?.status === 'IN_PROGRESS')).toBe(true);
        // Rolled back by the time the reason is shown: the row is OPEN again,
        // so it offers OPEN's action and not the next one.
        expect(within(table()).getByRole('button', { name: F.inProgress })).toBeInTheDocument();
        expect(within(table()).queryByRole('button', { name: F.readyForVerification })).toBeNull();
    });

    it('falls back to a sentence of its own when the server gives none', async () => {
        handler = (_url, init) => (init?.method === 'PUT' ? { status: 500, body: null } : undefined);
        mount('EDITOR');
        const action = await within(table()).findByRole('button', { name: F.inProgress });
        await act(async () => {
            fireEvent.click(action);
        });
        await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(F.statusUpdateFailed));
    });
});

describe('the table has no select column', () => {
    it.each<Role>(['ADMIN', 'READER'])('%s gets no row checkboxes', async (role) => {
        mount(role);
        await screen.findByText(ROW.title);
        expect(within(table()).queryAllByRole('checkbox')).toHaveLength(0);
    });
});

// ─── The finding's panel ──────────────────────────────────────────────
// Everything the create dialog collects was never shown again: the register
// has eight columns and rows had no click action.

const DETAIL = {
    id: 'finding-1',
    title: ROW.title,
    description: 'Q3 review evidence missing for two systems.',
    severity: 'HIGH',
    type: 'NONCONFORMITY',
    status: 'OPEN',
    analysis: 'Owner on leave during the window.',
    owner: null,
    dueDate: '2026-12-15T00:00:00.000Z',
    assigneeUserId: 'user-a',
    controlId: 'ctl-1',
    compensatingControlId: 'ctl-2',
    assignee: { id: 'user-a', name: 'Ana Petrova', email: 'ana@example.test' },
    control: { id: 'ctl-1', code: 'A.5.18', name: 'Access rights' },
    compensatingControl: { id: 'ctl-2', code: 'A.8.16', name: 'Monitoring activities' },
    audit: { id: 'audit-1', title: 'ISO 27001 internal audit 2026' },
    riskLinks: [{ risk: { id: 'risk-1', key: 'RSK-7', title: 'Unauthorised access' } }],
    evidenceLinks: [],
};

const detailHandler = (extra?: FetchHandler): FetchHandler => (url, init) => {
    const custom = extra?.(url, init);
    if (custom) return custom;
    if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/findings/finding-1')) return { status: 200, body: DETAIL };
    if (/\/(controls|risks|audits)(\?|$)/.test(url)) return { status: 200, body: { rows: [], truncated: false } };
    return undefined;
};

const panel = () => screen.getByTestId('finding-sheet-detail');

describe('a click on a finding opens its panel', () => {
    it('shows every field the create dialog collects', async () => {
        handler = detailHandler();
        mount('READER');
        fireEvent.click(await screen.findByText(ROW.title));
        await screen.findByTestId('finding-sheet-detail');
        const C = F.create;
        const rowValue = (label: string) => within(panel()).getByText(label).nextElementSibling as HTMLElement;
        expect(rowValue(C.labelType)).toHaveTextContent(F.typeOptions.NONCONFORMITY);
        expect(rowValue(C.labelAssignee)).toHaveTextContent('Ana Petrova');
        expect(rowValue(C.labelDueDate)).toHaveTextContent('15 Dec 2026');
        expect(within(rowValue(C.labelOriginatingAudit)).getByRole('link')).toHaveAttribute('href', '/t/acme/audits?selected=audit-1');
        expect(within(panel()).getByText(DETAIL.description)).toBeInTheDocument();
        expect(within(rowValue(C.labelLinkedControl)).getByRole('link')).toHaveAttribute('href', '/t/acme/controls/ctl-1');
        expect(within(rowValue(C.labelCompensatingControl)).getByRole('link')).toHaveAttribute('href', '/t/acme/controls/ctl-2');
        expect(within(panel()).getByRole('link', { name: /Unauthorised access/ })).toHaveAttribute('href', '/t/acme/risks/risk-1');
        expect(within(panel()).getByText(DETAIL.analysis)).toBeInTheDocument();
        // Severity and status ride the header.
        expect(document.getElementById('finding-sheet-severity')).toHaveTextContent(F.severityOptions.HIGH);
        expect(document.getElementById('finding-sheet-status')).toHaveTextContent(F.open);
    });

    it('opens from ?finding=<id>, the address other pages link to', async () => {
        handler = detailHandler();
        mockNav.searchParams = new URLSearchParams('finding=finding-1');
        mount('READER');
        expect(await screen.findByTestId('finding-sheet-detail')).toBeInTheDocument();
    });

    it('closing it drops the parameter, keeping the others', async () => {
        handler = detailHandler();
        mockNav.searchParams = new URLSearchParams('status=OPEN&finding=finding-1');
        mount('READER');
        await screen.findByTestId('finding-sheet-detail');
        fireEvent.click(screen.getByRole('button', { name: en.common.close }));
        await waitFor(() =>
            expect(mockNav.router.replace).toHaveBeenCalledWith('/t/acme/findings?status=OPEN', { scroll: false }),
        );
    });

    it.each<Role>(['READER', 'AUDITOR', 'AI_ADMIN'])('%s gets no Edit', async (role) => {
        handler = detailHandler();
        mount(role);
        fireEvent.click(await screen.findByText(ROW.title));
        await screen.findByTestId('finding-sheet-detail');
        expect(screen.queryByRole('button', { name: F.detail.edit })).toBeNull();
    });
});

describe('a role that can write edits the finding in its panel', () => {
    async function openEdit(role: Role = 'EDITOR') {
        mount(role);
        fireEvent.click(await screen.findByText(ROW.title));
        fireEvent.click(await screen.findByRole('button', { name: F.detail.edit }));
        return screen.findByTestId('finding-edit-form');
    }

    it.each<Role>(['OWNER', 'ADMIN', 'EDITOR'])('%s gets the form, seeded from the finding', async (role) => {
        handler = detailHandler();
        await openEdit(role);
        expect(document.getElementById('finding-edit-title')).toHaveValue(DETAIL.title);
        expect(document.getElementById('finding-edit-description')).toHaveValue(DETAIL.description);
        expect(document.getElementById('finding-edit-analysis')).toHaveValue(DETAIL.analysis);
    });

    it('sends only what changed, and an emptied field as null', async () => {
        handler = detailHandler((url, init) =>
            init?.method === 'PUT' ? { status: 200, body: { success: true, finding: { id: 'finding-1' } } } : undefined,
        );
        await openEdit();
        fireEvent.change(document.getElementById('finding-edit-title')!, { target: { value: 'Access reviews skipped in Q3' } });
        fireEvent.change(document.getElementById('finding-edit-analysis')!, { target: { value: '   ' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: F.detail.save }));
        });
        await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(F.detail.saved));
        const put = calls.find((c) => c.method === 'PUT');
        expect(put?.url).toBe('/api/t/acme/findings/finding-1');
        expect(put?.body).toEqual({ title: 'Access reviews skipped in Q3', analysis: null });
        // Back to the read view.
        await screen.findByTestId('finding-sheet-detail');
    });

    it("shows the server's reason when the save is refused", async () => {
        const REFUSAL = 'Assignee is not an active member of this tenant';
        handler = detailHandler((_url, init) =>
            init?.method === 'PUT'
                ? { status: 400, body: { error: { code: 'INVALID_ASSIGNEE', message: REFUSAL } } }
                : undefined,
        );
        await openEdit();
        fireEvent.change(document.getElementById('finding-edit-title')!, { target: { value: 'Changed' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: F.detail.save }));
        });
        expect(await screen.findByTestId('finding-edit-error')).toHaveTextContent(REFUSAL);
        expect(mockToast.success).not.toHaveBeenCalled();
    });
});

// ─── The status filter ────────────────────────────────────────────────
// The register had no filter: the dashboard's "Open Findings" arrow landed on
// a list that also held closed findings, and the truncation banner told the
// reader to refine filters that did not exist. The facet is sent to the API,
// so it narrows past the backfill cap rather than over the loaded rows.

describe('the register filters by status', () => {
    const CLOSED_ROW: Row = { ...ROW, id: 'finding-2', title: 'Closed out last quarter', status: 'CLOSED' };
    // The API answers a status-filtered read with only what matches.
    const byStatus: FetchHandler = (url) => {
        if (!/\/findings(\?|$)/.test(url)) return undefined;
        const status = new URL(url, 'http://localhost').searchParams.get('status');
        const rows = [ROW, CLOSED_ROW].filter((r) => !status || status.split(',').includes(r.status));
        return { status: 200, body: { rows, truncated: false } };
    };
    const openStatuses = 'OPEN,IN_PROGRESS,READY_FOR_VERIFICATION';

    afterEach(() => window.history.replaceState({}, '', '/'));

    it('offers a Filter control', async () => {
        handler = byStatus;
        mount('READER', [ROW, CLOSED_ROW]);
        await screen.findByText(ROW.title);
        expect(screen.getByRole('button', { name: en.common.ui.filter })).toBeInTheDocument();
    });

    it("the dashboard's link fetches the open statuses from the API and shows no closed finding", async () => {
        handler = byStatus;
        window.history.replaceState({}, '', `/t/acme/findings?status=${openStatuses}`);
        mount('READER', [ROW, CLOSED_ROW]);
        await waitFor(() =>
            expect(
                calls.some(
                    (c) =>
                        c.method === 'GET' &&
                        new URL(c.url, 'http://localhost').searchParams.get('status') === openStatuses,
                ),
            ).toBe(true),
        );
        await screen.findByText(ROW.title);
        await waitFor(() => expect(screen.queryByText(CLOSED_ROW.title)).toBeNull());
    });

    it('server-rendered rows for the same filter are used as they are', async () => {
        handler = byStatus;
        window.history.replaceState({}, '', '/t/acme/findings?status=CLOSED');
        render(
            <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 60_000, shouldRetryOnError: false, revalidateOnMount: false }}>
                <TooltipProvider>
                    <FindingsClient
                        initialFindings={[CLOSED_ROW]}
                        initialFilters={{ status: 'CLOSED' }}
                        tenantSlug="acme"
                        canCreate={false}
                        canEdit={false}
                        translations={TRANSLATIONS}
                    />
                </TooltipProvider>
            </SWRConfig>,
        );
        expect(screen.getByText(CLOSED_ROW.title)).toBeInTheDocument();
    });

    it('a status nobody holds says the filter matched nothing, and offers to clear it', async () => {
        handler = (url) => {
            if (!/\/findings(\?|$)/.test(url)) return undefined;
            const filtered = new URL(url, 'http://localhost').searchParams.has('status');
            return { status: 200, body: { rows: filtered ? [] : [ROW], truncated: false } };
        };
        window.history.replaceState({}, '', '/t/acme/findings?status=READY_FOR_VERIFICATION');
        mount('READER', []);
        expect(await screen.findByText(F.list.emptyMatchTitle)).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: F.list.clearFilters }));
        });
        expect(await screen.findByText(ROW.title)).toBeInTheDocument();
    });

    it('a status from another list is not sent to the API', async () => {
        handler = byStatus;
        window.history.replaceState({}, '', '/t/acme/findings?status=ACTIVE');
        mount('READER', [ROW, CLOSED_ROW]);
        await screen.findByText(ROW.title);
        await waitFor(() => expect(calls.some((c) => c.method === 'GET' && /\/findings(\?|$)/.test(c.url))).toBe(true));
        expect(calls.some((c) => /status=/.test(c.url))).toBe(false);
    });
});

describe('the status filter, driven from the toolbar', () => {
    afterEach(() => window.history.replaceState({}, '', '/'));

    // A server that remembers a status change, and answers a filtered read
    // with what matches now.
    function statefulServer(rows: Row[]): FetchHandler {
        const db = new Map(rows.map((r) => [r.id, { ...r }]));
        return (url, init) => {
            const method = init?.method ?? 'GET';
            const put = url.match(/\/findings\/([^/?]+)$/);
            if (method === 'PUT' && put) {
                const row = db.get(put[1]);
                if (row) row.status = (JSON.parse(String(init?.body)) as { status: string }).status;
                return { status: 200, body: { success: true, finding: row } };
            }
            if (method === 'GET' && /\/findings(\?|$)/.test(url)) {
                const status = new URL(url, 'http://localhost').searchParams.get('status');
                const out = [...db.values()].filter((r) => !status || status.split(',').includes(r.status));
                return { status: 200, body: { rows: out, truncated: false } };
            }
            return undefined;
        };
    }

    async function pickStatus(label: string) {
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: en.common.ui.filter }));
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${F.status}`) }));
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${label}`) }));
        });
    }

    it('picking a status asks the API for it', async () => {
        const CLOSED_ROW: Row = { ...ROW, id: 'finding-2', title: 'Closed out last quarter', status: 'CLOSED' };
        handler = statefulServer([ROW, CLOSED_ROW]);
        mount('READER', [ROW, CLOSED_ROW]);
        await screen.findByText(CLOSED_ROW.title);
        await pickStatus(F.open);
        await waitFor(() =>
            expect(calls.some((c) => new URL(c.url, 'http://localhost').searchParams.get('status') === 'OPEN')).toBe(true),
        );
        await waitFor(() => expect(screen.queryByText(CLOSED_ROW.title)).toBeNull());
        expect(screen.getByText(ROW.title)).toBeInTheDocument();
    });

    it('a status change after filtering refreshes the filtered view', async () => {
        handler = statefulServer([ROW]);
        mount('EDITOR');
        await screen.findByText(ROW.title);
        await pickStatus(F.open);
        await waitFor(() =>
            expect(calls.some((c) => new URL(c.url, 'http://localhost').searchParams.get('status') === 'OPEN')).toBe(true),
        );
        // The picker is still open over the page (`hidden: true` reaches the
        // table behind it); what matters is which list the change refreshes.
        const action = await within(table()).findByRole('button', { name: F.inProgress, hidden: true });
        await act(async () => {
            fireEvent.click(action);
        });
        // The finding is IN_PROGRESS now, so the Open view no longer holds it.
        // The status action used to capture the list key of the first render
        // and refresh the unfiltered list instead, leaving this row in place.
        await waitFor(() => expect(within(table()).queryByText(ROW.title)).toBeNull());
        expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
});
