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

/** The viewer — an Admin unless a test says otherwise. */
let mockViewer: {
    role: string;
    permissions: { canWrite: boolean; canAdmin: boolean };
    appPermissions: PermissionSet;
};

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: mockViewer.permissions,
        appPermissions: mockViewer.appPermissions,
        role: mockViewer.role,
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
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
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

/**
 * The API's real refusal envelope (`src/lib/errors/types.ts`). These tests
 * used to stub a flat `{ error: 'string' }`, which the API never sends —
 * and that hid the page reading only that shape, so every real refusal
 * showed the generic fallback instead of the server's reason (#4278).
 */
function refusal(message: string, code = 'FORBIDDEN') {
    return { error: { code, message, requestId: 'req-1' } };
}

beforeEach(() => {
    mockViewer = {
        role: 'ADMIN',
        permissions: { canWrite: true, canAdmin: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
});

/**
 * A built-in Editor, or a custom role built on Editor with some `tasks` or
 * `evidence` keys replaced. The write tier follows the base, as it does for
 * a real custom role.
 */
function viewAsEditor(
    tasks: Partial<PermissionSet['tasks']> = {},
    evidence: Partial<PermissionSet['evidence']> = {},
) {
    const editor = getPermissionsForRole('EDITOR');
    mockViewer = {
        role: 'EDITOR',
        permissions: { canWrite: true, canAdmin: false },
        appPermissions: {
            ...editor,
            tasks: { ...editor.tasks, ...tasks },
            evidence: { ...editor.evidence, ...evidence },
        },
    };
}

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
                return json(refusal('Reviewer gate: assignee cannot be the reviewer'), 403);
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
                return json(refusal('Comment rejected', 'BAD_REQUEST'), 400);
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

/**
 * #4278 — a reviewer named before the reviewer rule, whose role cannot edit
 * tasks (or who has left), can never sign the task off. Those tasks were not
 * migrated; the task page says so beside the reviewer picker that fixes it.
 */
describe('task detail — a reviewer who cannot sign off is called out', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    });

    function mountWith(reviewerCanSignOff: boolean) {
        const task = {
            ...TASK,
            reviewerUserId: 'user-rex',
            reviewer: { id: 'user-rex', name: 'Rex Reader', email: 'rex@example.com' },
            reviewerCanSignOff,
        };
        fetchMock.mockImplementation(async (url: string) =>
            url.split('?')[0] === '/api/t/acme/tasks/task_1' ? json(task) : baseGet(url),
        );
        renderPage();
    }

    it('shows the note when the server says the reviewer cannot sign off', async () => {
        mountWith(false);
        await waitForTaskLoaded();

        const note = await waitFor(() => {
            const el = document.getElementById('task-reviewer-cannot-sign-off');
            if (!el) throw new Error('no note yet');
            return el;
        });
        expect(note).toHaveTextContent(EN.reviewerCannotSignOff);
        // …and the picker beside it offers only members who CAN sign off.
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/users/assignable?audience=task-reviewer'),
        );
    });

    it('shows nothing when the reviewer can sign off', async () => {
        mountWith(true);
        await waitForTaskLoaded();
        await screen.findByText('Rex Reader');

        expect(document.getElementById('task-reviewer-cannot-sign-off')).toBeNull();
    });
});

/**
 * #4325 / #4328 — the edit dialog hosts the Task panel, whose assignee picker
 * POSTs to `/tasks/:id/assign` (`tasks.assign`), not the task's own edit
 * route. It followed the page's write tier alone, so a custom role without
 * `tasks.assign` could pick an assignee the server then refused.
 */
describe('task detail — the edit dialog’s assignee picker follows tasks.assign', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockImplementation(async (url: string) => baseGet(url));
        (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    });

    /** Open the edit dialog and wait for its form to load the task. */
    async function openEditDialog() {
        renderPage();
        await waitForTaskLoaded();
        fireEvent.click(document.getElementById('task-edit-button') as HTMLElement);
        await waitFor(() =>
            expect(document.getElementById('task-panel-title')).toHaveValue(TASK.title),
        );
    }

    it('a built-in Editor can pick an assignee there', async () => {
        viewAsEditor();
        await openEditDialog();

        expect(document.getElementById('task-panel-assignee')).toBeEnabled();
    });

    it('a custom role with tasks.edit but not tasks.assign gets a locked picker, and the fields stay editable', async () => {
        viewAsEditor({ assign: false });
        await openEditDialog();

        expect(document.getElementById('task-panel-assignee')).toBeDisabled();
        expect(document.getElementById('task-panel-title')).toBeEnabled();
    });
});

/**
 * #4360 — every write control on the page follows the write tier AND the key
 * its route checks. It followed the tier alone, so a custom role built on
 * Editor without the key was offered the control, and the server refused it.
 * Built-in roles hold every key their tier implies, so they see no change.
 */
describe('task detail — each write control follows its route’s key', () => {
    const CHECKLIST_STEP = 'step_1';
    const EVIDENCE_ID = 'ev_1';
    const LINK_ID = 'link_1';

    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockImplementation(async (url: string) => {
            const path = url.split('?')[0];
            if (path === '/api/t/acme/tasks/task_1') {
                return json({
                    ...TASK,
                    checklistJson: [{ id: CHECKLIST_STEP, text: 'Rotate the signing key', done: false }],
                });
            }
            if (path === '/api/t/acme/tasks/task_1/evidence') {
                return json({
                    links: [],
                    evidence: [
                        {
                            id: EVIDENCE_ID,
                            type: 'LINK',
                            title: 'Rotation runbook',
                            content: 'https://example.com/runbook',
                            status: 'SUBMITTED',
                            fileRecordId: null,
                            createdAt: '2026-08-01T00:00:00.000Z',
                        },
                    ],
                });
            }
            if (path === '/api/t/acme/tasks/task_1/links') {
                return json([
                    {
                        id: LINK_ID,
                        entityType: 'CONTROL',
                        entityId: 'ctl_1',
                        relation: 'RELATES_TO',
                        createdAt: '2026-08-01T00:00:00.000Z',
                        name: 'Access control policy',
                        path: '/controls/ctl_1',
                    },
                ]);
            }
            return baseGet(url);
        });
        (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    });

    const present = (id: string) => document.getElementById(id) !== null;

    /**
     * Mount the page and read, tab by tab, which write controls it offers.
     * One record per role, so each test states the whole table at once.
     */
    async function offeredControls() {
        renderPage();
        await waitForTaskLoaded();

        const checklistStep = await waitFor(() => {
            const el = document.getElementById(`task-checklist-item-${CHECKLIST_STEP}`);
            if (!el) throw new Error('checklist not painted yet');
            return el;
        });
        const overview = {
            statusPicker: present('task-status-select'),
            assignmentCard: present('assign-task-btn'),
            reviewerCard: present('assign-reviewer-btn'),
            editButton: present('task-edit-button'),
            checklistToggle: !(checklistStep as HTMLButtonElement).disabled,
        };

        fireEvent.click(screen.getByRole('tab', { name: /evidence/i }));
        await screen.findByText('Rotation runbook');
        const evidenceTrigger = present('add-evidence-btn');
        if (evidenceTrigger) fireEvent.click(document.getElementById('add-evidence-btn') as HTMLElement);
        const evidence = {
            evidenceTrigger,
            evidenceFileUpload: present('evidence-file-input'),
            evidenceUrlLink: present('evidence-url-input'),
            evidenceUnlink: present(`unlink-evidence-${EVIDENCE_ID}`),
        };

        fireEvent.click(screen.getByRole('tab', { name: /links/i }));
        await screen.findByText('Access control policy');
        const links = {
            addLink: present('add-link-btn'),
            removeLink: present(`remove-link-${LINK_ID}`),
        };

        return { ...overview, ...evidence, ...links };
    }

    const EVERYTHING = {
        statusPicker: true,
        assignmentCard: true,
        reviewerCard: true,
        editButton: true,
        checklistToggle: true,
        evidenceTrigger: true,
        evidenceFileUpload: true,
        evidenceUrlLink: true,
        evidenceUnlink: true,
        addLink: true,
        removeLink: true,
    };

    it('a built-in Editor keeps every control', async () => {
        viewAsEditor();
        expect(await offeredControls()).toEqual(EVERYTHING);
    });

    it('a custom role without tasks.edit gets none of the edit controls, and keeps assignment and file upload', async () => {
        viewAsEditor({ edit: false });
        expect(await offeredControls()).toEqual({
            ...EVERYTHING,
            statusPicker: false,
            reviewerCard: false,
            editButton: false,
            checklistToggle: false,
            // `POST /tasks/:id/evidence` and its DELETE ask `tasks.edit`;
            // the file goes to `/evidence/uploads`, which does not.
            evidenceUrlLink: false,
            evidenceUnlink: false,
            addLink: false,
            removeLink: false,
        });
    });

    it('a custom role without tasks.assign gets no assignment card', async () => {
        viewAsEditor({ assign: false });
        expect(await offeredControls()).toEqual({ ...EVERYTHING, assignmentCard: false });
    });

    it('a custom role without evidence.upload gets no file upload, and keeps the URL link', async () => {
        viewAsEditor({}, { upload: false });
        expect(await offeredControls()).toEqual({ ...EVERYTHING, evidenceFileUpload: false });
    });

    it('a custom role with neither tasks.edit nor evidence.upload is not offered the add-evidence form at all', async () => {
        viewAsEditor({ edit: false }, { upload: false });
        const offered = await offeredControls();
        expect(offered.evidenceTrigger).toBe(false);
        expect(offered.evidenceFileUpload).toBe(false);
        expect(offered.evidenceUrlLink).toBe(false);
    });
});

/** GETs against the bare list key (no query string). */
function getCountExactList(): number {
    return fetchMock.mock.calls.filter(
        ([url, init]) =>
            url === '/api/t/acme/tasks' && (!init || !init.method || init.method === 'GET'),
    ).length;
}

describe('task detail — removing someone else as a watcher follows tasks.edit', () => {
    // Removing YOURSELF needs no write permission; removing another person
    // makes `removeTaskWatcher` assert the write tier AND `tasks.edit`. The
    // page offered the × to an Admin on the write tier alone, so a custom role
    // built on Admin without `tasks.edit` was offered it and refused.
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockImplementation(async (url: string) => {
            const path = url.split('?')[0];
            if (path === '/api/t/acme/tasks/task_1') {
                return json({
                    ...TASK,
                    watchers: [
                        { id: 'w_other', userId: 'user_2', user: { name: 'Ana Petrova', email: 'ana@example.com' } },
                        { id: 'w_self', userId: 'user_1', user: { name: 'Me', email: 'me@example.com' } },
                    ],
                });
            }
            return baseGet(url);
        });
        (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    });

    it('a built-in Admin may remove another watcher', async () => {
        renderPage();
        await waitForTaskLoaded();
        expect(document.getElementById('remove-watcher-user_2')).not.toBeNull();
    });

    it('an Admin-based custom role without tasks.edit may remove only itself', async () => {
        const admin = getPermissionsForRole('ADMIN');
        mockViewer = {
            role: 'ADMIN',
            permissions: { canWrite: true, canAdmin: true },
            appPermissions: { ...admin, tasks: { ...admin.tasks, edit: false } },
        };
        renderPage();
        await waitForTaskLoaded();
        expect(document.getElementById('remove-watcher-user_1')).not.toBeNull();
        expect(document.getElementById('remove-watcher-user_2')).toBeNull();
    });
});

describe('task detail — delete, comments and the reviewer (owner decisions, 2026-10-26)', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockImplementation(async (url: string) => {
            const path = url.split('?')[0];
            if (path === '/api/t/acme/tasks/task_1') {
                return json({
                    ...TASK,
                    reviewerUserId: 'user_9',
                    reviewer: { id: 'user_9', name: 'Rada Ivanova', email: 'rada@example.com' },
                });
            }
            return baseGet(url);
        });
        (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    });

    /** A built-in role as the page receives it: its tier and its own key set. */
    function viewAs(role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'AUDITOR' | 'READER') {
        const tier = { OWNER: 5, ADMIN: 4, EDITOR: 3, AUDITOR: 2, READER: 1 }[role];
        mockViewer = {
            role,
            permissions: { canWrite: tier >= 3, canAdmin: tier >= 4 },
            appPermissions: getPermissionsForRole(role),
        };
    }

    async function openComments() {
        fireEvent.click(screen.getByRole('tab', { name: /comments/i }));
        await waitFor(() => expect(getCount('/api/t/acme/tasks/task_1/comments')).toBeGreaterThan(0));
    }

    it('Delete is offered to an Admin', async () => {
        viewAs('ADMIN');
        renderPage();
        await waitForTaskLoaded();
        expect(document.getElementById('delete-task-btn')).not.toBeNull();
    });

    it('Delete is not offered to an Editor, which the server would refuse', async () => {
        viewAs('EDITOR');
        renderPage();
        await waitForTaskLoaded();
        // The status picker beside it still shows: only Delete is withheld.
        expect(document.getElementById('task-status-select')).not.toBeNull();
        expect(document.getElementById('delete-task-btn')).toBeNull();
    });

    it('an Editor gets the comment box', async () => {
        viewAs('EDITOR');
        renderPage();
        await waitForTaskLoaded();
        await openComments();
        await waitFor(() => expect(document.getElementById('comment-body')).not.toBeNull());
    });

    it('an Auditor gets no comment box, which the server would refuse', async () => {
        viewAs('AUDITOR');
        renderPage();
        await waitForTaskLoaded();
        await openComments();
        expect(document.getElementById('comment-body')).toBeNull();
    });

    it('a Reader sees who the reviewer is, without the picker', async () => {
        viewAs('READER');
        renderPage();
        await waitForTaskLoaded();
        expect(document.getElementById('task-reviewer')).toHaveTextContent('Rada Ivanova');
        expect(document.getElementById('task-reviewer-input')).toBeNull();
        expect(document.getElementById('assign-reviewer-btn')).toBeNull();
    });
});
