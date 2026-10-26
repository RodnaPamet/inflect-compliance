/**
 * A filter change whose fetch fails must say so, not leave the previous
 * filter's rows on screen (#4276, #4278).
 *
 * `useTenantSWR` keeps the previous key's data, so after a failed filtered
 * fetch `data` is the unfiltered answer and the old `!data` check never
 * fired: the table went on showing every task under the new filter. The
 * check is now whether the current key has rows of its own.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen } from '@testing-library/react';
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
        // TasksClient publishes its displayed order, and that key is scoped by
        // the route slug — so the client's render path now reads useParams.
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { TasksClient, type TaskListMetrics } from '@/app/t/[tenantSlug]/(app)/tasks/TasksClient';
import { getPermissionsForRole } from '@/lib/permissions';

type TaskRow = React.ComponentProps<typeof TasksClient>['initialTasks'][number];

const en = require('../../messages/en.json');

const ANA = { id: 'u-ana', name: 'Ana Ader', email: 'ana@example.test' };
const BEA = { id: 'u-bea', name: 'Bea Bauer', email: 'bea@example.test' };
const task = (id: string, title: string, who: typeof ANA): TaskRow =>
    ({
        id,
        title,
        type: 'TASK',
        severity: 'MEDIUM',
        status: 'OPEN',
        source: 'MANUAL',
        key: id.toUpperCase(),
        assigneeUserId: who.id,
        assignee: who,
        control: null,
        dueAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
    }) as TaskRow;
const ROWS = [task('task-a', 'Patch the edge proxy', ANA), task('task-b', 'Tidy the runbook index', BEA)];
const METRICS: TaskListMetrics = { total: 2, byStatus: { OPEN: 2 }, overdue: 0, dueIn7d: 0 };

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/tasks');
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        const failed = url.pathname.endsWith('/tasks') && url.searchParams.has('assigneeUserId');
        const body = failed
            ? { error: { code: 'INTERNAL', message: 'boom' } }
            : url.pathname.endsWith('/tasks/metrics')
              ? METRICS
              : url.pathname.endsWith('/tasks')
                ? { rows: ROWS, truncated: false }
                : {};
        return {
            ok: !failed,
            status: failed ? 500 : 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
});

it('a filter whose fetch fails shows the load error, not the previous rows', async () => {
    const perms = getPermissionsForRole('EDITOR');
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TooltipProvider>
                <TasksClient
                    initialTasks={ROWS}
                    initialMetrics={METRICS}
                    tenantSlug="acme"
                    appPermissions={{
                        tasks: { create: perms.tasks.create, edit: perms.tasks.edit, assign: perms.tasks.assign },
                        admin: { manage: perms.admin.manage },
                    }}
                    permissions={{ canWrite: true, canAdmin: false }}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
    await screen.findAllByText('Tidy the runbook index');

    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: en.common.ui.filter }));
    });
    await act(async () => {
        fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${en.tasks.filters.assignee}`) }));
    });
    await act(async () => {
        fireEvent.click(await screen.findByRole('option', { name: new RegExp(ANA.name) }));
    });

    expect(await screen.findByText(en.tasks.list.loadError)).toBeTruthy();
    // Bea's task belongs to the unfiltered answer and must not stand in for
    // the filtered one.
    expect(screen.queryAllByText('Tidy the runbook index')).toHaveLength(0);
});
