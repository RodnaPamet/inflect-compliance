/**
 * B2-4 — the Tasks list must be able to answer "what is waiting on MY
 * sign-off?".
 *
 * The four-eyes gate (`checkReviewerSignOffGate`) makes exactly one
 * person able to complete a reviewer-gated task. This mounts the real
 * `TasksClient` and drives the "Awaiting my review" toggle the way a
 * user does, asserting the two things that make the queue real:
 *
 *   • the toggle narrows the list request with `awaitingReviewBy` bound
 *     to the SIGNED-IN user — not a bare "reviewer" facet, and not the
 *     current user's assignee filter;
 *   • the table then shows the task awaiting this user and drops the
 *     ones that are not (someone else's sign-off, and their own work).
 *
 * The fetch stub applies the filter the way the repository does, so a
 * regression that stops sending the parameter shows up as the unrelated
 * rows coming back on screen — not just as a changed URL string.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const CURRENT_USER = 'user-reviewer';

// This mounts the whole tasks page tree (table, filters, KPI strip,
// comboboxes, date pickers, chart bundles). The first mount in the file
// pays that tree's one-off module cost, which on a loaded machine runs
// to tens of seconds — so the file buys headroom over the 30s jsdom
// default and the 1s async default. Every assertion below is about
// WHICH rows appear, never about how fast they appear.
jest.setTimeout(600_000);
configure({ asyncUtilTimeout: 240_000 });

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
            if (params) for (const [p, val] of Object.entries(params)) s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const routerPush = jest.fn();
jest.mock('next/navigation', () => {
    // ONE instance, hoisted. A fresh `new URLSearchParams()` per call is a
    // new identity every render, and `useCreateQueryParam` has it in an
    // effect dep array — the page would re-render forever.
    const searchParams = new URLSearchParams();
    const router = { push: routerPush, replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/tasks',
        useSearchParams: () => searchParams,
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { TasksClient, type TaskListMetrics } from '@/app/t/[tenantSlug]/(app)/tasks/TasksClient';

type TaskRow = React.ComponentProps<typeof TasksClient>['initialTasks'][number];

const en = require('../../messages/en.json');
const LIST = en.tasks.list;

/** A list row in the shape the server sends. */
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

/**
 * The three-way split the filter has to get right: one task waiting on
 * THIS user, one waiting on someone else, and one of this user's own
 * tasks that is nowhere near review.
 */
const MINE_TO_REVIEW = row({ id: 'awaiting-mine', title: 'Quarterly access review sign-off', status: 'IN_REVIEW' });
const THEIRS_TO_REVIEW = row({ id: 'awaiting-theirs', title: 'Someone elses sign-off', status: 'IN_REVIEW' });
const MY_OWN_WORK = row({ id: 'my-own-work', title: 'Rotate the backup keys', status: 'IN_PROGRESS' });

const ALL_ROWS = [MINE_TO_REVIEW, THEIRS_TO_REVIEW, MY_OWN_WORK];
/** Server-side truth: reviewerUserId per task (never shipped to the list). */
const REVIEWER_OF: Record<string, string | null> = {
    'awaiting-mine': CURRENT_USER,
    'awaiting-theirs': 'user-someone-else',
    'my-own-work': null,
};

const listRequests: string[] = [];

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        let body: unknown = {};
        if (url.pathname.endsWith('/tasks/metrics')) {
            body = METRICS;
        } else if (url.pathname.endsWith('/tasks')) {
            listRequests.push(url.search);
            const awaiting = url.searchParams.get('awaitingReviewBy');
            // Mirror `_buildWhere`: IN_REVIEW *and* that user reviews it.
            const rows = awaiting
                ? ALL_ROWS.filter((r) => r.status === 'IN_REVIEW' && REVIEWER_OF[r.id] === awaiting)
                : ALL_ROWS;
            body = { rows, truncated: false };
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

const METRICS: TaskListMetrics = {
    total: ALL_ROWS.length,
    byStatus: { OPEN: 1, IN_REVIEW: 2 },
    overdue: 0,
    dueIn7d: 0,
};

beforeEach(() => {
    listRequests.length = 0;
    routerPush.mockReset();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/tasks');
    installFetch();
});

const mount = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <TasksClient
                    initialTasks={ALL_ROWS}
                    initialMetrics={METRICS}
                    tenantSlug="acme"
                    appPermissions={{ tasks: { create: true, edit: true } }}
                />
            </TooltipProvider>
        </SWRConfig>,
    );

function toggle() {
    return screen.getByRole('button', { name: LIST.awaitingMyReview });
}

describe('Tasks list — awaiting-my-review discovery filter', () => {
    /**
     * Warm the tree. The FIRST mount in this file compiles the whole
     * tasks page — table, filters, KPI strip, comboboxes, date pickers —
     * and on a loaded machine that mount intermittently settles after
     * the assertion budget. Paying it once, up front, with nothing
     * asserted keeps the real tests measuring behaviour rather than
     * module-load luck. Every mount after the first has been stable.
     */
    beforeAll(async () => {
        installFetch();
        const view = mount();
        await act(async () => { await Promise.resolve(); });
        try {
            await screen.findByText(MY_OWN_WORK.title);
        } catch {
            /* warm-up only — the tests below do the asserting */
        }
        view.unmount();
        listRequests.length = 0;
    });

    it('scopes the list to this user\'s sign-off queue, and releases it again', async () => {
        mount();

        // Wait on the CHROME, not the data: the toggle renders from the
        // first paint. Asserting rows before any interaction would race
        // the initial SWR read, whose promise settles outside the act
        // queue; every assertion below follows a `fireEvent`, which
        // wraps in act and flushes it.
        await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'));

        fireEvent.click(toggle());

        // Their own in-progress work is gone…
        await waitFor(() => {
            expect(screen.queryByText(MY_OWN_WORK.title)).not.toBeInTheDocument();
        });
        // …the task waiting on THEIR sign-off stays…
        expect(screen.getByText(MINE_TO_REVIEW.title)).toBeInTheDocument();
        // …and the one in review under someone else's name does not.
        expect(screen.queryByText(THEIRS_TO_REVIEW.title)).not.toBeInTheDocument();
        expect(toggle()).toHaveAttribute('aria-pressed', 'true');

        // The narrowing happened on the SERVER request, bound to the
        // signed-in user — not by hiding rows client-side.
        const last = new URLSearchParams(listRequests[listRequests.length - 1]);
        expect(last.get('awaitingReviewBy')).toBe(CURRENT_USER);
        // …and it did NOT borrow the assignee facet to do it: "assigned
        // to me" and "awaiting my review" are different questions.
        expect(last.get('assigneeUserId')).toBeNull();
        expect(screen.getByRole('button', { name: LIST.assignedToMe }))
            .toHaveAttribute('aria-pressed', 'false');

        // Toggling off releases the queue — the unfiltered list, which is
        // everything, comes back.
        fireEvent.click(toggle());
        await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'));
        await waitFor(() => {
            expect(screen.getByText(MY_OWN_WORK.title)).toBeInTheDocument();
        });
        expect(screen.getByText(MINE_TO_REVIEW.title)).toBeInTheDocument();
        expect(screen.getByText(THEIRS_TO_REVIEW.title)).toBeInTheDocument();
    });

    it('restores from a deep link — the key survives a reload', async () => {
        window.history.replaceState({}, '', `/t/acme/tasks?awaitingReviewBy=${CURRENT_USER}`);
        render(
            <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
                <TooltipProvider>
                    <TasksClient
                        initialTasks={[MINE_TO_REVIEW]}
                        initialMetrics={METRICS}
                        initialFilters={{ awaitingReviewBy: CURRENT_USER }}
                        tenantSlug="acme"
                        appPermissions={{ tasks: { create: true, edit: true } }}
                    />
                </TooltipProvider>
            </SWRConfig>,
        );

        // The toggle comes up already pressed…
        await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'true'));
        // …and the queue it names is what the page asks the server for.
        // (Which rows that returns is the first test's assertion; this one
        // is about the key surviving the round trip through the URL.)
        await waitFor(() => expect(listRequests.length).toBeGreaterThan(0));
        expect(
            new URLSearchParams(listRequests[listRequests.length - 1]).get('awaitingReviewBy'),
        ).toBe(CURRENT_USER);
    });
});
