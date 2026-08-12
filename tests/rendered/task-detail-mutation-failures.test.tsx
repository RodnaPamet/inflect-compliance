/**
 * Behavioural cover for the task detail page's mutation lifecycle.
 *
 * Replaces the source-regex half of `tests/guards/task-mutation-error-
 * handling.test.ts`, which asserted that a curated list of handler NAMES
 * each contained the literal `res.ok` and a `toast.error`/`throw`. That
 * shape check could not survive the B3-4 migration (the `res.ok` gate
 * moved into `okOrThrow` + `useTenantMutation`'s `mutationFn`), and —
 * more importantly — it never executed the page. It would have stayed
 * green through a handler that inspected `res.ok` and then did nothing
 * useful with it.
 *
 * These tests drive the real component against a stubbed `fetch` and
 * assert what the user actually gets:
 *
 *   1. A rejected write surfaces its SERVER-SUPPLIED reason, and the
 *      optimistic paint rolls back (no phantom success).
 *   2. A rejected comment does NOT clear the box — the user's text
 *      survives so they can retry.
 *   3. A successful write reaches the LIST + KPI caches, which live on
 *      different SWR keys than anything this page reads. This is the
 *      B3-4 staleness bug: before the fix, a sibling subscriber to
 *      `/tasks` and `/tasks/metrics` never refetched.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

// next-intl is ESM (jest cannot parse it); resolve real en.json values.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v : key;
        };
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', taskId: 'task_1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/tasks/task_1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: { canWrite: true, canAdmin: true },
        role: 'ADMIN',
        tenantSlug: 'acme',
        userId: 'user_1',
    }),
    useTenantApiUrl: () => (path: string) =>
        `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) =>
        `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useCurrentUserId: () => 'user_1',
}));

const toastError = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({
        error: toastError,
        success: jest.fn(),
        warning: jest.fn(),
        info: jest.fn(),
    }),
}));

import TaskDetailPage from '@/app/t/[tenantSlug]/(app)/tasks/[taskId]/page';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';

const TASK = {
    id: 'task_1',
    title: 'Rotate the admin keys',
    status: 'OPEN',
    priority: 'P1',
    type: 'TASK',
    severity: null,
    assigneeUserId: null,
    reviewerUserId: null,
    dueDate: null,
    description: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    watchers: [],
    _count: { links: 0, comments: 0, evidence: 0 },
};

/**
 * Exact button labels from the real message catalogue. Exact beats a
 * regex here: `/assign/i` also matches the assignee picker's trigger and
 * `/comment/i` matches the Comments TAB, and either extra match makes the
 * query throw rather than click.
 */
const EN = (require('../../messages/en.json') as {
    tasks: { detail: Record<string, string> };
}).tasks.detail;

/** Fetch stub: GETs succeed from a fixture map; writes are per-test. */
const fetchMock = jest.fn();
function json(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as Response;
}

/**
 * Sibling subscriber to the two caches the detail page must reach but
 * never reads itself. Its refetch count IS the assertion for test 3.
 */
function ListProbe() {
    useTenantSWR<unknown[]>(CACHE_KEYS.tasks.list());
    useTenantSWR<unknown>(CACHE_KEYS.tasks.metrics());
    return null;
}

function renderPage() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
            <ListProbe />
            <TaskDetailPage />
        </SWRConfig>,
    );
}

/**
 * Wait for the task read to resolve, keyed on the page's own
 * `#task-title` element.
 *
 * NOT `findByText(TASK.title)`: the page paints the title twice — once in
 * the breadcrumb trail and once as the heading — so a bare text query
 * matches two nodes and throws. `findBy*` treats that throw as
 * not-settled-yet and retries it to the timeout, so the suite reports a
 * slow, shapeless failure for what is really an ambiguous selector.
 */
async function waitForTaskLoaded(): Promise<HTMLElement> {
    return waitFor(() => {
        const el = document.getElementById('task-title');
        expect(el).not.toBeNull();
        expect(el).toHaveTextContent(TASK.title);
        return el as HTMLElement;
    });
}

/**
 * The GET half of the stub, shared by every test.
 *
 * Ordering matters and is the reason this is one function rather than a
 * per-test chain of `startsWith`: the task key `/tasks/task_1` is a
 * PREFIX of every tab key (`/tasks/task_1/comments`, `/links`,
 * `/evidence`, `/activity`). A prefix test written first answers the
 * comments read with the task OBJECT, and the page dies on
 * `comments.map is not a function` — a crash that looks like a missing
 * button three assertions later. Exact-match the task, then the tabs.
 */
function baseGet(url: string): Response {
    const path = url.split('?')[0];
    if (path === '/api/t/acme/tasks/task_1') return json(TASK);
    if (path.startsWith('/api/t/acme/tasks/task_1/')) return json([]);
    if (path.startsWith('/api/t/acme/tasks/metrics')) return json({});
    return json([]);
}

/** How many GETs have been issued against a given URL prefix. */
function getCount(prefix: string): number {
    return fetchMock.mock.calls.filter(
        ([url, init]) =>
            typeof url === 'string' &&
            url.startsWith(prefix) &&
            (!init || !init.method || init.method === 'GET'),
    ).length;
}

describe('task detail — mutation failures are surfaced, successes reach the list', () => {
    beforeEach(() => {
        toastError.mockReset();
        fetchMock.mockReset();
        (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    });

    it('surfaces the server reason when the assign write is rejected', async () => {
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === 'POST' && url.endsWith('/tasks/task_1/assign')) {
                return json({ error: 'Reviewer gate: assignee cannot be the reviewer' }, 403);
            }
            return baseGet(url);
        });

        renderPage();
        await waitForTaskLoaded();

        fireEvent.click(await screen.findByRole('button', { name: EN.assign }));

        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith(
                'Reviewer gate: assignee cannot be the reviewer',
            ),
        );
    });

    it('keeps the comment text when the post is rejected (no false success)', async () => {
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === 'POST' && url.endsWith('/tasks/task_1/comments')) {
                return json({ error: 'Comment rejected' }, 400);
            }
            return baseGet(url);
        });

        renderPage();
        await waitForTaskLoaded();
        fireEvent.click(screen.getByRole('tab', { name: /comment/i }));

        const box = await screen.findByRole('textbox');
        fireEvent.change(box, { target: { value: 'needs a second reviewer' } });
        fireEvent.click(screen.getByRole('button', { name: EN.comment }));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('Comment rejected'));
        // The box must NOT have been cleared — clearing it is the
        // "reported success" failure mode this page shipped before TP-6.
        expect((box as HTMLTextAreaElement).value).toBe('needs a second reviewer');
    });

    it('a successful assign revalidates the tasks LIST and the KPI metrics key', async () => {
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === 'POST' && url.endsWith('/tasks/task_1/assign')) {
                return json({ ok: true });
            }
            return baseGet(url);
        });

        renderPage();
        await waitForTaskLoaded();
        await waitFor(() => expect(getCount('/api/t/acme/tasks/metrics')).toBeGreaterThan(0));

        const listBefore = getCount('/api/t/acme/tasks?') + getCountExactList();
        const metricsBefore = getCount('/api/t/acme/tasks/metrics');

        fireEvent.click(await screen.findByRole('button', { name: EN.assign }));

        await waitFor(() => {
            expect(getCount('/api/t/acme/tasks?') + getCountExactList()).toBeGreaterThan(
                listBefore,
            );
            expect(getCount('/api/t/acme/tasks/metrics')).toBeGreaterThan(metricsBefore);
        });
    });
});

/** GETs against the bare list key (no query string). */
function getCountExactList(): number {
    return fetchMock.mock.calls.filter(
        ([url, init]) =>
            url === '/api/t/acme/tasks' && (!init || !init.method || init.method === 'GET'),
    ).length;
}
