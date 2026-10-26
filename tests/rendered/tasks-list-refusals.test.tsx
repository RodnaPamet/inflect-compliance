/**
 * The Tasks list against a server that says no (#4278).
 *
 * Mounts the real `TasksClient` and drives it the way a user does, against
 * a `fetch` stub that answers in the API's real error envelope —
 * `{ error: { code, message } }`. The suites that came before mocked a flat
 * string `error`, which the API never sends, and so could not see that
 * every refusal on this page was replaced by one generic sentence.
 *
 *   1. A refused bulk action, bulk delete and restore each show the
 *      server's reason, not the generic fallback.
 *   2. Bulk Change Status never offers Open, which no task can move to.
 *   3. The Deleted view never shows LIVE rows — not while it loads, and
 *      not when its fetch fails (it shows the error instead).
 *   4. A deleted row cannot be opened: no title button, no quick-edit
 *      pencil, no row navigation — each led to "Task not found".
 *   5. An assignee with no name shows their email, not the dash an
 *      unassigned task shows.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

const CURRENT_USER = 'user-me';

// Same budgets as the other TasksClient suites: mounting the whole page
// tree is a one-off module cost of tens of seconds on a loaded machine;
// every assertion is about WHAT renders, never how fast.
jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
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
    // ONE hoisted instance — see tasks-list-role-surface.test.tsx.
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
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

// Toasts are asserted by what they were asked to say. The undo-toast runs
// its action at once — the 5-second window is the hook's own concern
// (covered by its tests); what is under test here is what the PAGE does
// with the action's outcome.
const toastError = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({
        error: toastError,
        success: jest.fn(),
        warning: jest.fn(),
        info: jest.fn(),
    }),
    useToastWithUndo: () => (input: {
        action: () => Promise<unknown>;
        onCommit?: (r: unknown) => void;
        onError?: (e: unknown) => void;
    }) => {
        void Promise.resolve()
            .then(() => input.action())
            .then(
                (r) => input.onCommit?.(r),
                (e) => input.onError?.(e),
            );
        return 'undo-toast';
    },
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { TasksClient, type TaskListMetrics } from '@/app/t/[tenantSlug]/(app)/tasks/TasksClient';
import { TASK_TRANSITIONS } from '@/app-layer/domain/task-status';

type TaskRow = React.ComponentProps<typeof TasksClient>['initialTasks'][number];

const en = require('../../messages/en.json');
const LIST = en.tasks.list;
const BULK = en.tasks.bulk;
const STATUS = en.tasks.statusLabels as Record<string, string>;

function row(over: Partial<TaskRow> & { id: string; title: string }): TaskRow {
    return {
        type: 'TASK',
        severity: 'MEDIUM',
        status: 'TRIAGED',
        source: 'MANUAL',
        key: over.id.toUpperCase(),
        assigneeUserId: null,
        assignee: null,
        control: null,
        // A real date, so the Due cell never renders the "—" an empty
        // date shows — the Assignee assertions below look for that dash.
        dueAt: '2026-12-01T00:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...over,
    };
}

const LIVE = row({ id: 'task-live', title: 'Patch the edge proxy' });
const NAMELESS = row({
    id: 'task-nameless',
    title: 'Review the firewall export',
    assigneeUserId: 'user-dana',
    assignee: { id: 'user-dana', name: null, email: 'dana@example.com' },
});
const LIVE_ROWS = [LIVE, NAMELESS];
const DELETED = row({
    id: 'task-deleted',
    title: 'Retire the legacy VPN',
    deletedAt: '2026-08-02T00:00:00.000Z',
    deletedByUserId: CURRENT_USER,
});

const METRICS: TaskListMetrics = {
    total: LIVE_ROWS.length,
    byStatus: { TRIAGED: LIVE_ROWS.length },
    overdue: 0,
    dueIn7d: 0,
};

/** The API's real refusal envelope. */
function refusal(status: number, message: string) {
    return { status, body: { error: { code: 'REFUSED', message, requestId: 'req-1' } } };
}

interface Reply {
    status?: number;
    body: unknown;
}

/** Per-test overrides; a function may return a promise to hold the reply. */
let routes: {
    deleted?: () => Reply | Promise<Reply>;
    bulkStatus?: Reply;
    bulkDelete?: Reply;
    restore?: Reply;
};

function response({ status = 200, body }: Reply): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://test.local');
        const method = init?.method ?? 'GET';
        if (method === 'POST' && url.pathname.endsWith('/tasks/bulk/status') && routes.bulkStatus) {
            return response(routes.bulkStatus);
        }
        if (method === 'POST' && url.pathname.endsWith('/tasks/bulk/delete') && routes.bulkDelete) {
            return response(routes.bulkDelete);
        }
        if (method === 'POST' && url.pathname.endsWith('/restore') && routes.restore) {
            return response(routes.restore);
        }
        if (url.pathname.endsWith('/tasks/metrics')) return response({ body: METRICS });
        if (url.pathname.endsWith('/tasks')) {
            if (url.searchParams.get('includeDeleted') === 'true') {
                return response(
                    routes.deleted ? await routes.deleted() : { body: { rows: [DELETED], truncated: false } },
                );
            }
            return response({ body: { rows: LIVE_ROWS, truncated: false } });
        }
        return response({ body: [] });
    }) as unknown as typeof fetch;
}

function mount() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TooltipProvider>
                <TasksClient
                    initialTasks={LIVE_ROWS}
                    initialMetrics={METRICS}
                    tenantSlug="acme"
                    appPermissions={{
                        tasks: { create: true, edit: true, assign: true },
                        evidence: { upload: true },
                        admin: { manage: true },
                    }}
                    permissions={{ canWrite: true, canAdmin: true }}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

const byId = (id: string) => document.getElementById(id);

/** Select every row, then pick `action` in the bulk bar. */
async function chooseBulkAction(actionLabel: string) {
    const boxes = await screen.findAllByRole('checkbox');
    await act(async () => {
        fireEvent.click(boxes[0]);
    });
    const select = await waitFor(() => {
        const el = byId('bulk-action-select');
        if (!el) throw new Error('no bulk bar yet');
        return el;
    });
    fireEvent.click(select);
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: actionLabel }));
}

/** Open the bulk status picker and return its option labels. */
async function bulkStatusOptions(): Promise<string[]> {
    const input = await waitFor(() => {
        const el = byId('bulk-value-input');
        if (!el) throw new Error('no status picker yet');
        return el;
    });
    fireEvent.click(input);
    const listbox = await screen.findByRole('listbox');
    return within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim() ?? '');
}

async function openDeletedView() {
    const user = userEvent.setup();
    const trigger = await waitFor(() => {
        const el = byId('tasks-views-menu');
        if (!el) throw new Error('no views menu yet');
        return el;
    });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: LIST.showDeleted }));
}

beforeAll(async () => {
    // Warm the module graph once — see tasks-list-role-surface.test.tsx.
    routes = {};
    installFetch();
    const view = mount();
    try {
        await screen.findByText(LIVE.title);
    } catch {
        /* warm-up only */
    }
    view.unmount();
});

beforeEach(() => {
    routes = {};
    routerPush.mockReset();
    toastError.mockReset();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/tasks');
    installFetch();
});

describe('Tasks list — a refused write shows the server’s reason', () => {
    it('bulk Change Status', async () => {
        const reason =
            'Cannot change the status of "Patch the edge proxy": This task has a reviewer, so it must be In review before it can be closed.';
        routes.bulkStatus = refusal(400, reason);
        mount();
        await screen.findByText(LIVE.title);

        await chooseBulkAction(BULK.changeStatus);
        await bulkStatusOptions();
        fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: STATUS.BLOCKED }));
        fireEvent.click(byId('bulk-apply-btn')!);

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(reason));
        expect(toastError).not.toHaveBeenCalledWith(BULK.failed);
    });

    it('bulk Delete, once the undo window has run', async () => {
        const reason = 'You do not have permission to delete these tasks.';
        routes.bulkDelete = refusal(403, reason);
        mount();
        await screen.findByText(LIVE.title);

        await chooseBulkAction(BULK.delete);
        fireEvent.click(byId('bulk-apply-btn')!);

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(reason));
        expect(toastError).not.toHaveBeenCalledWith(BULK.failed);
    });

    it('Restore, in the Deleted view', async () => {
        const reason = 'Task cannot be restored: its control has been deleted.';
        routes.restore = refusal(409, reason);
        mount();
        await screen.findByText(LIVE.title);

        await openDeletedView();
        const restore = await waitFor(() => {
            const el = byId(`restore-task-${DELETED.id}`);
            if (!el) throw new Error('no restore button yet');
            return el;
        });
        fireEvent.click(restore);

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(reason));
        expect(toastError).not.toHaveBeenCalledWith(BULK.restoreFailed);
    });
});

describe('Tasks list — bulk Change Status offers only statuses a task can move to', () => {
    it('never offers Open', async () => {
        mount();
        await screen.findByText(LIVE.title);

        await chooseBulkAction(BULK.changeStatus);
        const options = await bulkStatusOptions();

        expect(options).not.toContain(STATUS.OPEN);
        // Every offered status is the target of at least one transition —
        // the property OPEN failed.
        const reachable = new Set(
            Object.values(TASK_TRANSITIONS).flatMap((targets) => [...targets]),
        );
        const offered = Object.entries(STATUS)
            .filter(([, label]) => options.includes(label))
            .map(([status]) => status);
        expect(offered.length).toBe(options.length);
        for (const status of offered) expect(reachable.has(status as never)).toBe(true);
    });
});

describe('Tasks list — the Deleted view shows deleted rows only', () => {
    it('shows the loading state, not the live rows, while the deleted list loads', async () => {
        let release: (r: Reply) => void = () => undefined;
        routes.deleted = () => new Promise<Reply>((resolve) => { release = resolve; });
        mount();
        await screen.findByText(LIVE.title);

        await openDeletedView();

        // The live rows are gone the moment the view switches — they used
        // to stay up under the deleted columns until the fetch landed.
        await waitFor(() => expect(screen.queryByText(LIVE.title)).not.toBeInTheDocument());
        expect(byId(`restore-task-${LIVE.id}`)).toBeNull();

        await act(async () => {
            release({ body: { rows: [DELETED], truncated: false } });
        });
        await screen.findByText(DELETED.title);
        expect(byId(`restore-task-${DELETED.id}`)).not.toBeNull();
    });

    it('shows the load error, not the live rows, when the deleted list is refused', async () => {
        routes.deleted = () => refusal(403, 'You do not have permission to view deleted tasks.');
        mount();
        await screen.findByText(LIVE.title);

        await openDeletedView();

        await screen.findByText(LIST.loadError);
        expect(screen.queryByText(LIVE.title)).not.toBeInTheDocument();
        expect(byId(`restore-task-${LIVE.id}`)).toBeNull();
    });

    it('a deleted row cannot be opened — no title button, no pencil, no navigation', async () => {
        mount();
        await screen.findByText(LIVE.title);
        await openDeletedView();
        await screen.findByText(DELETED.title);

        // The live title is a button that opens the quick view; the
        // deleted one is plain text, and its row has no pencil.
        expect(byId(`task-link-${DELETED.id}`)).toBeNull();
        expect(screen.queryByTestId(`task-quick-edit-${DELETED.id}`)).not.toBeInTheDocument();

        const tr = screen.getByTestId(`task-title-${DELETED.id}`).closest('tr') as HTMLElement;
        fireEvent.click(tr);
        fireEvent.doubleClick(tr);
        fireEvent.click(screen.getByText(DELETED.title));

        expect(routerPush).not.toHaveBeenCalled();
        expect(
            screen.queryByRole('button', { name: `Collapse ${LIST.quickViewTitle} panel` }),
        ).not.toBeInTheDocument();
    });
});

describe('Tasks list — the Assignee column', () => {
    it('shows the email of an assignee with no name, and the dash only when unassigned', async () => {
        mount();
        await screen.findByText(LIVE.title);

        const namelessRow = screen.getByTestId(`task-title-${NAMELESS.id}`).closest('tr') as HTMLElement;
        expect(within(namelessRow).getByText('dana@example.com')).toBeInTheDocument();
        expect(within(namelessRow).queryByText('—')).not.toBeInTheDocument();

        const unassignedRow = screen.getByTestId(`task-title-${LIVE.id}`).closest('tr') as HTMLElement;
        expect(within(unassignedRow).getByText('—')).toBeInTheDocument();
    });
});
