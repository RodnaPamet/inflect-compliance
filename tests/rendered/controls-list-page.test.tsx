/**
 * The Controls list, executed (#4275).
 *
 * `ControlsClient` is fenced by a few dozen files that read its SOURCE and,
 * until this file, nothing that mounted it. The defects in #4275 are all of
 * the kind a source reader cannot see — a button offered to a role the
 * server refuses, a banner that is missing, a toast that says the opposite
 * of the response — so this file mounts the real page and asserts what a
 * user gets:
 *
 *   1. the write surface follows BOTH permission layers the server checks
 *      (the route's granular key AND the usecase's coarse tier), including
 *      for custom roles, where the two disagree;
 *   2. `/controls?create=1` opens the dialog only for a viewer who may create;
 *   3. a controls-dashboard drill-down (`?due=soon`) is visible, does not
 *      leave the Total card reading as selected, and is cleared by
 *      "Clear filters"; and under a Category filter the status cards show
 *      a dash with the reason, not a count that ignores the filter;
 *   4. a bulk status change the server applied to only some controls says so;
 *   5. a second owner can be picked in the Owner filter;
 *   6. a custom control's stored theme category reads as its label.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

// Mounting the whole page tree costs a one-off module load that runs long on
// a loaded machine; every assertion is about WHAT renders. Same budget
// reasoning as tests/rendered/tasks-list-role-surface.test.tsx.
jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

// ─── Mocks ───────────────────────────────────────────────────────────

/** Per-test navigation state. ONE URLSearchParams instance per test — a
 *  fresh one per call would be a new identity every render. */
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

jest.mock('next/navigation', () => ({
    useRouter: () => mockNav.router,
    usePathname: () => '/t/acme/controls',
    useSearchParams: () => mockNav.searchParams,
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme' }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
}));

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

// The page's toasts — observed directly rather than through a mounted
// Toaster, so an assertion names the method (success vs warning).
const mockToast = {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
};
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => mockToast,
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { ControlsClient } from '@/app/t/[tenantSlug]/(app)/controls/ControlsClient';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';

const en = require('../../messages/en.json');
const C = en.controls;

// ─── Fixtures ────────────────────────────────────────────────────────

type ControlRow = React.ComponentProps<typeof ControlsClient>['initialControls'][number];

function row(over: Partial<ControlRow> & { id: string; name: string }): ControlRow {
    return {
        code: null,
        annexId: null,
        status: 'IN_PROGRESS',
        applicability: 'APPLICABLE',
        applicabilityDecidedAt: '2026-01-01T00:00:00.000Z',
        category: null,
        frequency: null,
        owner: null,
        _count: { evidenceLinks: 0, evidenceControlLinks: 0 },
        taskTotal: 0,
        taskDone: 0,
        frameworks: [],
        ...over,
    };
}

/** A custom control as the create dialog writes it: auto-minted code, a
 *  theme constant for its category. */
const CUSTOM = row({ id: 'c-custom', name: 'Encrypt laptops', code: 'CTL-1', category: 'TECHNOLOGICAL' });
const OTHER = row({ id: 'c-other', name: 'Review firewall rules', code: 'CTL-2' });
const ALL_ROWS = [CUSTOM, OTHER];

const KPI = { total: 2, implemented: 0, inProgress: 2, notStarted: 0 };

/** What the list GET returns in this test. */
let listRows: ControlRow[] = ALL_ROWS;
/** What the bulk status POST returns. */
let bulkStatusResponse: unknown = { results: [], updated: 0 };

function respond(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        const p = url.pathname;
        if (p === '/api/t/acme/controls') {
            if (url.searchParams.get('includeDeleted') === 'true') return respond(listRows);
            // The Owner facet is a server filter — honour it the way the
            // repository now does (comma-joined ids).
            const owners = url.searchParams.get('ownerUserId')?.split(',');
            const rows = owners ? listRows.filter((r) => r.owner && owners.includes(r.owner.id)) : listRows;
            return respond({ rows, truncated: false, kpiCounts: KPI });
        }
        if (p === '/api/t/acme/controls/bulk/status') return respond(bulkStatusResponse);
        if (p.endsWith('/controls/health-verdicts')) return respond({ verdicts: [] });
        if (p.endsWith('/dashboard/trends')) return respond({ dataPoints: [] });
        // Member lookups, activity feeds, evidence lists — empty.
        return respond([]);
    }) as unknown as typeof fetch;
}

// ─── Mounting ────────────────────────────────────────────────────────

type Coarse = React.ComponentProps<typeof ControlsClient>['permissions'];
type AppPerms = React.ComponentProps<typeof ControlsClient>['appPermissions'];

/** `computePermissions` (src/lib/tenant-context.ts), restated: that module
 *  imports the Prisma client. */
function coarse(role: Role): Coarse {
    const level = { OWNER: 5, ADMIN: 4, EDITOR: 3, AUDITOR: 2, READER: 1, AI_ADMIN: 1 }[role];
    return {
        canRead: level >= 1,
        canWrite: level >= 3,
        canAdmin: level >= 4,
        canAudit: role === 'AUDITOR' || level >= 4,
        canExport: level >= 2,
    };
}

/** The page's appPermissions slice for a built-in role, from the REAL
 *  resolver the server page uses. */
function granular(role: Role): AppPerms {
    const p = getPermissionsForRole(role);
    return {
        controls: p.controls,
        tasks: { edit: p.tasks.edit },
        admin: { manage: p.admin.manage },
    };
}

function mount(opts: {
    permissions: Coarse;
    appPermissions: AppPerms;
    search?: string;
    initialControls?: ControlRow[];
}) {
    const search = opts.search ?? '';
    mockNav.searchParams = new URLSearchParams(search);
    window.history.replaceState({}, '', `/t/acme/controls${search ? `?${search}` : ''}`);
    const initialFilters: Record<string, string> = {};
    for (const [k, v] of mockNav.searchParams) if (k !== 'create') initialFilters[k] = v;
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <ControlsClient
                    initialControls={opts.initialControls ?? listRows}
                    initialFilters={initialFilters}
                    tenantSlug="acme"
                    permissions={opts.permissions}
                    appPermissions={opts.appPermissions}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

const mountAs = (role: Role, search?: string) =>
    mount({ permissions: coarse(role), appPermissions: granular(role), search });

async function openViewsMenu() {
    const user = userEvent.setup();
    await user.click(document.getElementById('controls-views-menu') as HTMLElement);
    await waitFor(() => expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0));
}

/** The control's `<tr>`, re-queried until attached (see the tasks test). */
async function rowFor(c: ControlRow): Promise<HTMLElement> {
    return waitFor(() => {
        const tr = screen.getByTestId(`control-title-${c.id}`).closest('tr');
        expect(tr).not.toBeNull();
        return tr as HTMLElement;
    });
}

/**
 * Wait until the page's mount-time reads (the list, the health verdicts,
 * the KPI trends) have all answered and React has settled on them. A node
 * captured before the last of them re-renders the table can be detached by
 * the time it is clicked, and a click on a detached node does nothing.
 */
async function readsSettled() {
    await waitFor(() => {
        const paths = (global.fetch as jest.Mock).mock.calls.map(
            ([u]) => new URL(String(u), 'https://test.local').pathname,
        );
        expect(paths).toEqual(
            expect.arrayContaining([
                '/api/t/acme/controls',
                '/api/t/acme/controls/health-verdicts',
                '/api/t/acme/dashboard/trends',
            ]),
        );
    });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** Tick the header select-all, then let the page's settled selection catch
 *  up (250ms — so a double-click never mounts the rail; a person takes
 *  longer than that to reach Apply, and so must a test). */
async function selectEveryRow() {
    await readsSettled();
    // Two acts, not one: the first flushes the click's render and effects —
    // which is what STARTS the page's 250ms settle timer — and only then
    // does the second wait it out. Waiting inside the first act would start
    // the timer after the wait.
    await act(async () => {
        fireEvent.click(screen.getAllByRole('checkbox')[0]);
    });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
    });
}

/** Open the bulk action picker and return its listbox. */
async function openBulkActions(): Promise<HTMLElement> {
    const select = await waitFor(() => {
        const el = document.getElementById('bulk-action-select');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    fireEvent.click(select);
    return screen.findByRole('listbox');
}

beforeEach(() => {
    listRows = ALL_ROWS;
    bulkStatusResponse = { results: [], updated: 0 };
    mockNav.router.push.mockReset();
    mockNav.router.replace.mockReset();
    for (const fn of Object.values(mockToast)) fn.mockReset();
    window.localStorage.clear();
    installFetch();
});

// Warm the tree once — the first mount compiles the whole page.
beforeAll(async () => {
    installFetch();
    const view = mountAs('OWNER');
    try {
        await screen.findByText(CUSTOM.name);
    } catch {
        /* warm-up only */
    }
    view.unmount();
});

// ─── 1. The write surface ────────────────────────────────────────────

describe('Controls list — the write surface follows both permission layers', () => {
    it('OWNER: create button, row checkboxes and the Deleted view', async () => {
        mountAs('OWNER');
        await screen.findByText(CUSTOM.name);
        expect(document.getElementById('new-control-btn')).not.toBeNull();
        expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
        await openViewsMenu();
        expect(document.getElementById('controls-show-deleted-toggle')).not.toBeNull();
    });

    it.each(['READER', 'AUDITOR', 'AI_ADMIN'] as const)(
        '%s: no create button, no checkboxes, and one click opens the control',
        async (role) => {
            mountAs(role);
            await screen.findByText(CUSTOM.name);
            expect(document.getElementById('new-control-btn')).toBeNull();
            // The select column is on by default; withholding only the bar
            // left these roles ticking rows that had no actions.
            expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
            // With nothing to select, a single click is the row's action.
            await readsSettled();
            fireEvent.click(await rowFor(OTHER));
            await waitFor(() =>
                expect(mockNav.router.push).toHaveBeenCalledWith(`/t/acme/controls/${OTHER.id}`),
            );
        },
    );

    it('a READER-based custom role granted controls.create/edit gets no write surface', async () => {
        // The usecases assert canWrite AND the flag; the coarse tier comes
        // from the BASE role. The flags alone used to show the create
        // button and an editable quick view, both of which 403.
        const reader = granular('READER');
        mount({
            permissions: coarse('READER'),
            appPermissions: { ...reader, controls: { create: true, edit: true } },
        });
        await screen.findByText(CUSTOM.name);
        expect(document.getElementById('new-control-btn')).toBeNull();
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
        // The quick view opens read-only.
        await readsSettled();
        fireEvent.click(screen.getByTestId(`control-title-${CUSTOM.id}`));
        const panel = await screen.findByTestId('control-edit-panel');
        const fieldset = within(panel).getByTestId('control-edit-form').querySelector('fieldset');
        expect(fieldset).toBeDisabled();
    });

    /** An ADMIN-based custom role with `admin.manage` switched off. */
    const adminWithoutManage = () => {
        const admin = granular('ADMIN');
        return mount({
            permissions: coarse('ADMIN'),
            appPermissions: { ...admin, admin: { manage: false } },
        });
    };

    it('an ADMIN-based custom role without admin.manage gets no Deleted view', async () => {
        // Restore and purge are requirePermission('admin.manage'); the coarse
        // tier (from the ADMIN base) said yes.
        adminWithoutManage();
        await screen.findByText(CUSTOM.name);
        await openViewsMenu();
        expect(document.getElementById('controls-show-deleted-toggle')).toBeNull();
    });

    it('an ADMIN-based custom role without admin.manage gets no bulk delete', async () => {
        adminWithoutManage();
        await screen.findByText(CUSTOM.name);
        await selectEveryRow();
        const listbox = await openBulkActions();
        const labels = within(listbox).getAllByRole('option').map((o) => o.textContent?.trim());
        // The editing verbs, which it does hold, are still offered.
        expect(labels).toEqual(expect.arrayContaining([C.bulk.setStatus, C.bulk.assignOwner]));
        expect(labels).not.toContain(C.bulk.delete);
    });

    it('a built-in ADMIN is offered bulk delete (the negative above is real)', async () => {
        mountAs('ADMIN');
        await screen.findByText(CUSTOM.name);
        await selectEveryRow();
        const listbox = await openBulkActions();
        expect(within(listbox).getByRole('option', { name: C.bulk.delete })).toBeInTheDocument();
    });
});

// ─── 2. /controls/new deep link ──────────────────────────────────────

describe('Controls list — ?create=1', () => {
    it('does not open the New Control dialog for a READER (and still strips the param)', async () => {
        mountAs('READER', 'create=1');
        await screen.findByText(CUSTOM.name);
        await waitFor(() => expect(mockNav.router.replace).toHaveBeenCalledWith('/t/acme/controls', { scroll: false }));
        expect(document.getElementById('control-name-input')).toBeNull();
    });

    it('opens it for an EDITOR', async () => {
        mountAs('EDITOR', 'create=1');
        await waitFor(() => expect(document.getElementById('control-name-input')).not.toBeNull());
    });
});

// ─── 3. Dashboard drill-downs ────────────────────────────────────────

function totalCard(): HTMLElement {
    const card = screen
        .getAllByTestId('kpi-filter-card')
        .find((el) => el.textContent?.includes(C.kpi.total));
    expect(card).toBeDefined();
    return card as HTMLElement;
}

describe('Controls list — a dashboard drill-down is visible and clearable', () => {
    it('?due=soon shows a banner naming it, and the Total card is not selected', async () => {
        mountAs('EDITOR', 'due=soon');
        await screen.findByText(CUSTOM.name);
        const banner = document.getElementById('controls-drill-down-banner');
        expect(banner).not.toBeNull();
        expect(banner).toHaveTextContent(C.list.drillDown.dueSoon);
        // The card counts the whole register; with the list narrowed it must
        // not read as the active view.
        expect(totalCard()).toHaveAttribute('aria-pressed', 'false');
    });

    it('without a drill-down the Total card IS selected (the negative above is real)', async () => {
        mountAs('EDITOR');
        await screen.findByText(CUSTOM.name);
        expect(document.getElementById('controls-drill-down-banner')).toBeNull();
        expect(totalCard()).toHaveAttribute('aria-pressed', 'true');
    });

    it('an empty drill-down offers Clear filters, and clearing drops the drill-down', async () => {
        listRows = [];
        mountAs('EDITOR', 'due=soon');
        // Not "No controls yet · Install a framework" — the list is narrowed.
        await screen.findByRole('button', { name: C.empty.clearFilters });
        await readsSettled();
        expect(screen.getByText(C.empty.filterTitle)).toBeInTheDocument();
        expect(screen.queryByText(C.empty.noRecordsTitle)).not.toBeInTheDocument();
        mockNav.router.replace.mockClear();
        fireEvent.click(screen.getByRole('button', { name: C.empty.clearFilters }));
        // The URL the filter context writes no longer carries `due`.
        await waitFor(() => expect(mockNav.router.replace).toHaveBeenCalled());
        const last = mockNav.router.replace.mock.calls.at(-1)?.[0] as string;
        expect(last).toBe('/t/acme/controls');
    });

    it('the banner link keeps the other filters and drops only the drill-down', async () => {
        mountAs('EDITOR', 'due=soon&status=IN_PROGRESS');
        await screen.findByText(CUSTOM.name);
        expect(document.getElementById('controls-drill-down-clear')).toHaveAttribute(
            'href',
            '/t/acme/controls?status=IN_PROGRESS',
        );
    });
});

// ─── 3b. Status cards under a Category filter ────────────────────────

function kpiCard(label: string): HTMLElement {
    const card = screen
        .getAllByTestId('kpi-filter-card')
        .find((el) => el.querySelector('span')?.textContent === label);
    expect(card).toBeDefined();
    return card as HTMLElement;
}

describe('Controls list — the status cards under a Category filter', () => {
    const STATUS_CARDS = [C.kpi.implemented, C.kpi.inProgress, C.kpi.notStarted];

    it('show a dash and say why, instead of a count that ignores the filter', async () => {
        // Category is filtered in the browser; the cards are server counts
        // that cannot see it. KPI has inProgress: 2 — a number that would
        // contradict a Category-filtered table.
        mountAs('EDITOR', 'category=TECHNOLOGICAL');
        await screen.findByText(CUSTOM.name);
        for (const label of STATUS_CARDS) {
            const card = kpiCard(label);
            expect(card.querySelector('[data-metric-value]')).toHaveTextContent('—');
            expect(card).toHaveTextContent(C.kpi.notCountedByCategory);
        }
        // The Total card counts the whole register by design, and says so.
        expect(kpiCard(C.kpi.total).querySelector('[data-metric-value]')).toHaveTextContent(String(KPI.total));
    });

    it('show their counts without one (the dash above is the filter, not the page)', async () => {
        mountAs('EDITOR');
        await screen.findByText(CUSTOM.name);
        expect(kpiCard(C.kpi.inProgress).querySelector('[data-metric-value]')).toHaveTextContent(String(KPI.inProgress));
        expect(screen.queryByText(C.kpi.notCountedByCategory)).not.toBeInTheDocument();
    });
});

// ─── 4. Bulk results ─────────────────────────────────────────────────

describe('Controls list — bulk status reports what the server skipped', () => {
    async function applyBulkStatus() {
        await screen.findByText(CUSTOM.name);
        await selectEveryRow();
        fireEvent.click(
            within(await openBulkActions()).getByRole('option', { name: C.bulk.setStatus }),
        );
        const valueInput = await waitFor(() => {
            const el = document.getElementById('bulk-value-input');
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });
        fireEvent.click(valueInput);
        fireEvent.click(
            within(await screen.findByRole('listbox')).getByRole('option', {
                name: C.filterEnums.status.IMPLEMENTED,
            }),
        );
        const apply = await waitFor(() => {
            const el = document.getElementById('bulk-apply-btn') as HTMLButtonElement | null;
            expect(el).not.toBeNull();
            expect(el).not.toBeDisabled();
            return el as HTMLButtonElement;
        });
        await act(async () => {
            fireEvent.click(apply);
        });
        // The POST went out — so a missing toast below is the page's doing.
        await waitFor(() =>
            expect(
                (global.fetch as jest.Mock).mock.calls.some(([u]) =>
                    String(u).endsWith('/controls/bulk/status'),
                ),
            ).toBe(true),
        );
    }

    it('one of two skipped: a warning naming the counts, not "Changes applied"', async () => {
        bulkStatusResponse = {
            results: [
                { id: CUSTOM.id, status: 'ok' },
                { id: OTHER.id, status: 'not_found' },
            ],
            updated: 1,
        };
        mountAs('EDITOR');
        await applyBulkStatus();
        await waitFor(() => expect(mockToast.warning).toHaveBeenCalled());
        expect(mockToast.warning).toHaveBeenCalledWith(
            C.bulk.partlyApplied
                .replace('{applied}', '1')
                .replace('{total}', '2')
                .replace('{skipped}', '1'),
        );
        expect(mockToast.success).not.toHaveBeenCalled();
    });

    it('all skipped: says nothing changed', async () => {
        bulkStatusResponse = {
            results: [
                { id: CUSTOM.id, status: 'not_found' },
                { id: OTHER.id, status: 'not_found' },
            ],
            updated: 0,
        };
        mountAs('EDITOR');
        await applyBulkStatus();
        await waitFor(() => expect(mockToast.warning).toHaveBeenCalledWith(C.bulk.noneApplied));
        expect(mockToast.success).not.toHaveBeenCalled();
    });

    it('none skipped: still "Changes applied"', async () => {
        bulkStatusResponse = {
            results: [
                { id: CUSTOM.id, status: 'ok' },
                { id: OTHER.id, status: 'ok' },
            ],
            updated: 2,
        };
        mountAs('EDITOR');
        await applyBulkStatus();
        await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(C.bulk.applied));
        expect(mockToast.warning).not.toHaveBeenCalled();
    });
});

// ─── 5. Owner picker ─────────────────────────────────────────────────

describe('Controls list — the Owner picker keeps every owner after a pick', () => {
    const ADA_ROW = row({ id: 'c-ada', name: 'Rotate keys', owner: { id: 'u-ada', name: 'Ada', email: 'ada@acme.test' } });
    const BOB_ROW = row({ id: 'c-bob', name: 'Patch servers', owner: { id: 'u-bob', name: 'Bob', email: 'bob@acme.test' } });

    it('a second owner can be picked, and both reach the list read', async () => {
        // Owner is a SERVER filter: after the first pick the loaded rows are
        // that owner's only, and options derived from them alone offered no
        // second owner to pick.
        listRows = [ADA_ROW, BOB_ROW];
        mountAs('EDITOR');
        await screen.findByText(BOB_ROW.name);
        await readsSettled();

        fireEvent.click(document.querySelector('[data-filter-trigger]') as HTMLElement);
        fireEvent.click(await screen.findByRole('option', { name: new RegExp(C.filters.owner) }));
        fireEvent.click(await screen.findByRole('option', { name: /Ada/ }));

        // The read narrows to Ada's control…
        await waitFor(() => expect(screen.queryByText(BOB_ROW.name)).not.toBeInTheDocument());
        // …and Bob is still offered in the still-open picker.
        const bob = await screen.findByRole('option', { name: /Bob/ });
        fireEvent.click(bob);

        await waitFor(() => {
            const reads = (global.fetch as jest.Mock).mock.calls
                .map(([u]) => new URL(String(u), 'https://test.local'))
                .filter((u) => u.pathname === '/api/t/acme/controls');
            const owners = reads.at(-1)?.searchParams.get('ownerUserId')?.split(',').sort();
            expect(owners).toEqual(['u-ada', 'u-bob']);
        });
        // Both owners' controls are listed again. (Re-queried inside waitFor:
        // a node captured before the last re-render may be detached.)
        await waitFor(() => expect(screen.getByText(BOB_ROW.name)).toBeInTheDocument());
        expect(screen.getByText(ADA_ROW.name)).toBeInTheDocument();
    });
});

// ─── 6. Category label ───────────────────────────────────────────────

describe('Controls list — a stored theme category reads as its label', () => {
    it('the Category column shows "Technological", not TECHNOLOGICAL', async () => {
        mountAs('EDITOR');
        const tr = await rowFor(CUSTOM);
        expect(tr).toHaveTextContent(C.categoryLabels.TECHNOLOGICAL);
        expect(tr).not.toHaveTextContent('TECHNOLOGICAL');
    });

    it('so does its group in the Browse rail', async () => {
        // Open the rail (it starts collapsed-to-spine; the choice persists).
        window.localStorage.setItem('aside:collapsed:controls-list-browse', 'false');
        mountAs('EDITOR');
        await screen.findByText(CUSTOM.name);
        const rail = await screen.findByTestId('controls-browse-aside');
        await waitFor(() => expect(rail).toHaveTextContent(C.categoryLabels.TECHNOLOGICAL));
        expect(rail).not.toHaveTextContent('TECHNOLOGICAL');
    });
});
