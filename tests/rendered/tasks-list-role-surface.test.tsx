/**
 * B3-2 — the Tasks list, executed.
 *
 * `TasksClient` is the third page found with the ControlsClient /
 * AuditsClient shape: a large client island fenced by ~22 files that
 * read its SOURCE and one rendered test that drives it. Source readers
 * cannot fail on the defects that matter here — a bulk action offered
 * to a READER, a quick-view panel that opens but never switches, a
 * severity badge whose tone contradicts the task's own detail page —
 * because all three of those spellings look identical in the file.
 *
 * So this file mounts the real component and asserts what a user gets:
 *
 *   1. the write surface each ROLE sees, derived from the real
 *      `getPermissionsForRole` rather than hand-written booleans, so a
 *      permission-model change lands here rather than in prose;
 *   2. the quick-view panel opening from both affordances, switching
 *      task→task in place, and closing;
 *   3. row double-click still navigating to the full detail page;
 *   4. severity tone agreeing with the shared map the detail page reads
 *      (B2-6 — the list used to keep a divergent copy).
 *
 * Deletes on landing: `tests/guards/tasks-quickview-interaction.test.ts`
 * (whole file — (2) and (3) cover its three behavioural claims, and its
 * fourth is an `existsSync` on a file deleted years of commits ago) and
 * the two `Tasks page RBAC` cases in `tests/unit/rbac-guardrails.test.ts`
 * (regexes for the strings `appPermissions.tasks.create` / `.edit`,
 * which (1) covers by consequence).
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

const CURRENT_USER = 'user-me';

// Mounting the whole tasks page tree (table, filters, KPI strip,
// comboboxes, date pickers) costs a one-off module load that runs to
// tens of seconds on a loaded machine. Every assertion below is about
// WHAT renders, never how fast — so buy headroom over the 30s jsdom
// default and the 1s async default rather than trading flake for speed.
//
// The async budget is deliberately NOT set to the per-test budget.
// `asyncUtilTimeout` is what a FAILING `findBy*` costs before it
// reports, and every retry re-runs the query over the whole tree — so a
// minutes-long value turns one genuine regression into a CI job that
// looks hung instead of red. 20s absorbs a loaded machine's slowest
// legitimate settle; the per-test budget keeps the module-load headroom.
jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

let currentPermissions = {
    canRead: true,
    canWrite: true,
    canAdmin: true,
    canAudit: false,
    canExport: true,
};

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: currentPermissions,
    }),
    usePermissions: () => ({}),
    useCurrentUserId: () => CURRENT_USER,
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
                    s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const routerPush = jest.fn();
jest.mock('next/navigation', () => {
    // ONE hoisted instance — a fresh `new URLSearchParams()` per call is
    // a new identity every render and `useCreateQueryParam` has it in an
    // effect dep array, so the page would re-render forever.
    const searchParams = new URLSearchParams();
    const router = {
        push: routerPush,
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/tasks',
        useSearchParams: () => searchParams,
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { TasksClient, type TaskListMetrics } from '@/app/t/[tenantSlug]/(app)/tasks/TasksClient';
import { getPermissionsForRole } from '@/lib/permissions';
import { TASK_SEVERITY_VARIANT } from '@/app-layer/domain/entity-status-mapping';
import type { Role } from '@prisma/client';

type TaskRow = React.ComponentProps<typeof TasksClient>['initialTasks'][number];

const en = require('../../messages/en.json');
const LIST = en.tasks.list;
const BULK = en.tasks.bulk;

function row(over: Partial<TaskRow> & { id: string; title: string }): TaskRow {
    return {
        type: 'TASK',
        severity: 'MEDIUM',
        status: 'OPEN',
        source: 'MANUAL',
        key: over.id.toUpperCase(),
        assigneeUserId: null,
        assignee: null,
        control: null,
        dueAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...over,
    };
}

const HIGH_TASK = row({ id: 'task-high', title: 'Patch the edge proxy', severity: 'HIGH' });
const LOW_TASK = row({ id: 'task-low', title: 'Tidy the runbook index', severity: 'LOW' });
const ALL_ROWS = [HIGH_TASK, LOW_TASK];

const METRICS: TaskListMetrics = {
    total: ALL_ROWS.length,
    byStatus: { OPEN: ALL_ROWS.length },
    overdue: 0,
    dueIn7d: 0,
};

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        let body: unknown = {};
        if (url.pathname.endsWith('/tasks/metrics')) {
            body = METRICS;
        } else if (url.pathname.endsWith('/tasks')) {
            body = { rows: ALL_ROWS, truncated: false };
        } else if (/\/tasks\/[^/]+$/.test(url.pathname)) {
            // The quick-view panel re-fetches full detail on open.
            const id = url.pathname.split('/').pop();
            const seed = ALL_ROWS.find((r) => r.id === id) ?? HIGH_TASK;
            body = { ...seed, description: '', watchers: [], links: [], evidence: [] };
        }
        return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

/**
 * Mount as `role` — the write surface comes from the SAME resolver the
 * server page uses, so this cannot drift from the permission model the
 * way a hand-written `{ create: true, edit: true }` literal would.
 */
function mountAs(role: Role) {
    const perms = getPermissionsForRole(role);
    currentPermissions = {
        canRead: perms.tasks.view,
        canWrite: perms.tasks.edit,
        canAdmin: role === 'OWNER' || role === 'ADMIN',
        canAudit: role === 'AUDITOR',
        canExport: true,
    };
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <TasksClient
                    initialTasks={ALL_ROWS}
                    initialMetrics={METRICS}
                    tenantSlug="acme"
                    appPermissions={{
                        tasks: { create: perms.tasks.create, edit: perms.tasks.edit },
                    }}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

/** Tick every row's selection checkbox. */
async function selectEveryRow() {
    const boxes = await screen.findAllByRole('checkbox');
    // The first checkbox is the header select-all.
    await act(async () => {
        fireEvent.click(boxes[0]);
    });
}

beforeEach(() => {
    routerPush.mockReset();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/tasks');
    installFetch();
});

describe('Tasks list — the write surface each role actually gets', () => {
    /**
     * Warm the tree once. The FIRST mount in this file compiles the
     * whole tasks page and on a loaded machine intermittently settles
     * after the assertion budget; paying it up front with nothing
     * asserted keeps the real tests measuring behaviour rather than
     * module-load luck.
     */
    beforeAll(async () => {
        installFetch();
        const view = mountAs('OWNER');
        await act(async () => {
            await Promise.resolve();
        });
        try {
            await screen.findByText(HIGH_TASK.title);
        } catch {
            /* warm-up only */
        }
        view.unmount();
    });

    it.each(['OWNER', 'ADMIN', 'EDITOR'] as const)(
        '%s can create, quick-edit, and reach all four bulk actions',
        async (role) => {
            mountAs(role);
            await screen.findByText(HIGH_TASK.title);

            expect(screen.getByRole('button', { name: LIST.addBtn })).toBeInTheDocument();
            expect(screen.getByTestId(`task-quick-edit-${HIGH_TASK.id}`)).toBeInTheDocument();

            await selectEveryRow();

            // The bulk bar appears with the selection and offers the four
            // actions the tasks API supports — assign, status, due, delete.
            const select = await waitFor(() => {
                const el = document.getElementById('bulk-action-select');
                expect(el).not.toBeNull();
                return el;
            });
            expect(select).not.toBeNull();
            fireEvent.click(select as HTMLElement);

            const listbox = await screen.findByRole('listbox');
            const labels = within(listbox)
                .getAllByRole('option')
                .map((o) => o.textContent?.trim());
            expect(labels).toEqual(
                expect.arrayContaining([
                    BULK.assign,
                    BULK.changeStatus,
                    BULK.setDueDate,
                    BULK.delete,
                ]),
            );
        },
    );

    it.each(['READER', 'AUDITOR'] as const)(
        '%s gets a read-only list — no create, no quick-edit, no bulk bar',
        async (role) => {
            mountAs(role);
            await screen.findByText(HIGH_TASK.title);

            // The rows are there — this role can READ tasks…
            expect(screen.getByText(LOW_TASK.title)).toBeInTheDocument();
            // …and every write affordance is absent, not merely disabled.
            expect(screen.queryByRole('button', { name: LIST.addBtn })).not.toBeInTheDocument();
            expect(screen.queryByTestId(`task-quick-edit-${HIGH_TASK.id}`)).not.toBeInTheDocument();

            const boxes = screen.queryAllByRole('checkbox');
            if (boxes.length > 0) {
                await act(async () => {
                    fireEvent.click(boxes[0]);
                });
            }
            // Selecting rows must NOT summon a bulk bar for a read-only
            // role — the surface that would let them assign or delete in
            // bulk is the one thing the role gate has to hold.
            expect(document.getElementById('bulk-action-select')).toBeNull();
        },
    );
});

describe('Tasks list — quick-view panel', () => {
    it('opens from a title click, switches task→task in place, and closes', async () => {
        mountAs('EDITOR');
        await screen.findByText(HIGH_TASK.title);

        // Nothing open yet.
        expect(screen.queryByText(LIST.quickViewTitle)).not.toBeInTheDocument();

        fireEvent.click(screen.getByTestId(`task-title-${HIGH_TASK.id}`));

        const panel = await screen.findByText(LIST.quickViewTitle);
        expect(panel).toBeInTheDocument();
        // The panel is showing THIS task…
        await waitFor(() =>
            expect(screen.getAllByDisplayValue(HIGH_TASK.title).length).toBeGreaterThan(0),
        );
        // …and the table is still on screen beneath it — this is the
        // non-modal rail, not a dimming modal that replaces the list.
        expect(screen.getByText(LOW_TASK.title)).toBeInTheDocument();

        // Clicking a DIFFERENT task swaps the panel's contents without a
        // close-first. (The panel is keyed by task id precisely so this
        // re-seeds; a regression here leaves the first task's fields up.)
        fireEvent.click(screen.getByTestId(`task-title-${LOW_TASK.id}`));
        await waitFor(() =>
            expect(screen.getAllByDisplayValue(LOW_TASK.title).length).toBeGreaterThan(0),
        );
        expect(screen.queryByDisplayValue(HIGH_TASK.title)).not.toBeInTheDocument();

        // And it closes.
        fireEvent.click(screen.getByRole('button', { name: `Collapse ${LIST.quickViewTitle} panel` }));
        await waitFor(() =>
            expect(screen.queryByDisplayValue(LOW_TASK.title)).not.toBeInTheDocument(),
        );
    });

    it('opens from the row quick-edit pencil without navigating away', async () => {
        mountAs('EDITOR');
        await screen.findByText(HIGH_TASK.title);

        fireEvent.click(screen.getByTestId(`task-quick-edit-${HIGH_TASK.id}`));

        await screen.findByText(LIST.quickViewTitle);
        // The pencil stops propagation, so the row's navigate handler
        // must not have fired — losing the list here is the regression.
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('row double-click still navigates to the full detail page', async () => {
        mountAs('EDITOR');
        const title = await screen.findByText(HIGH_TASK.title);
        const row = title.closest('tr');
        expect(row).not.toBeNull();

        fireEvent.doubleClick(row as HTMLElement);

        await waitFor(() =>
            expect(routerPush).toHaveBeenCalledWith(`/t/acme/tasks/${HIGH_TASK.id}`),
        );
    });
});

describe('Tasks list — severity tone (B2-6)', () => {
    /**
     * The list kept its own severity→tone literal that disagreed with
     * `TASK_SEVERITY_VARIANT` on LOW and HIGH, so one task looked like
     * two different severities depending on the page. Asserting the
     * rendered CLASS against the shared map is what makes re-inlining a
     * divergent copy fail: a source scanner sees two spellings of the
     * same object and cannot tell them apart.
     */
    it.each([
        [HIGH_TASK, 'HIGH'],
        [LOW_TASK, 'LOW'],
    ])('renders $1 with the shared map’s tone', async (task, level) => {
        mountAs('EDITOR');
        const title = await screen.findByText(task.title);
        const rowEl = title.closest('tr') as HTMLElement;

        const expectedTone = TASK_SEVERITY_VARIANT[level];
        // StatusBadge paints its tone through `text-content-<variant>`.
        const badge = within(rowEl).getByText(
            en.tasks.filterEnums.severity[level],
        );
        expect(badge.className).toContain(`content-${expectedTone}`);
    });
});
