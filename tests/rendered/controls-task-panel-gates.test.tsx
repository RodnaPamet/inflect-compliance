/**
 * The Controls list's Task quick view, opened from a control's expanded task
 * rows, passes the Task panel the keys its two other routes check (#4325,
 * #4328):
 *
 *   - the evidence box's file upload POSTs to `/evidence/uploads`
 *     (`evidence.upload`);
 *   - the assignee picker POSTs to `/tasks/:id/assign` (`tasks.assign` and
 *     the write tier).
 *
 * Both followed `tasks.edit` alone, so a custom role holding it without the
 * other key was offered a control the server refused. A built-in Editor,
 * which holds all three, is the control case.
 *
 * Mounting set-up as in `tests/rendered/controls-list-page.test.tsx`.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

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

import { TooltipProvider } from '@/components/ui/tooltip';
import { ControlsClient } from '@/app/t/[tenantSlug]/(app)/controls/ControlsClient';
import { getPermissionsForRole } from '@/lib/permissions';

type ControlRow = React.ComponentProps<typeof ControlsClient>['initialControls'][number];
type AppPerms = React.ComponentProps<typeof ControlsClient>['appPermissions'];

const CONTROL: ControlRow = {
    id: 'c-task',
    name: 'Log access',
    code: 'CTL-3',
    annexId: null,
    status: 'IN_PROGRESS',
    applicability: 'APPLICABLE',
    applicabilityDecidedAt: '2026-01-01T00:00:00.000Z',
    category: null,
    frequency: null,
    owner: null,
    _count: { evidenceLinks: 0, evidenceControlLinks: 0 },
    taskTotal: 1,
    taskDone: 0,
    frameworks: [],
};
const TASK = {
    id: 't-1',
    key: 'TSK-1',
    title: 'Collect the access log',
    status: 'OPEN',
    severity: 'MEDIUM',
    assignee: null,
    _count: { evidence: 0 },
};

function respond(body: unknown): Response {
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/controls');
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const p = new URL(String(input), 'https://test.local').pathname;
        if (p === '/api/t/acme/controls') {
            return respond({ rows: [CONTROL], truncated: false, kpiCounts: { total: 1, implemented: 0, inProgress: 1, notStarted: 0 } });
        }
        if (p.endsWith('/controls/health-verdicts')) return respond({ verdicts: [] });
        if (p.endsWith('/dashboard/trends')) return respond({ dataPoints: [] });
        // The expanded row's linked tasks, and the Task panel's own read.
        if (p === '/api/t/acme/tasks') return respond([TASK]);
        if (p === `/api/t/acme/tasks/${TASK.id}`) {
            return respond({ ...TASK, description: null, type: 'TASK', priority: 'P2', dueAt: null, assigneeUserId: null });
        }
        // Member lookups, activity feeds, evidence lists — empty.
        return respond([]);
    }) as unknown as typeof fetch;
});

/**
 * A built-in role's slice, from the REAL resolver the server page uses;
 * `over` replaces keys the way a custom role built on that role would.
 */
function slice(
    role: 'EDITOR' | 'READER',
    over: { tasksEdit?: boolean; evidenceUpload?: boolean; tasksAssign?: boolean } = {},
): AppPerms {
    const p = getPermissionsForRole(role);
    return {
        controls: p.controls,
        tasks: { edit: over.tasksEdit ?? p.tasks.edit, assign: over.tasksAssign ?? p.tasks.assign },
        evidence: { upload: over.evidenceUpload ?? p.evidence.upload },
        risks: { create: p.risks.create },
        admin: { manage: p.admin.manage },
    };
}

const editorWith = (over: { evidenceUpload?: boolean; tasksAssign?: boolean } = {}) => slice('EDITOR', over);

function mount(appPermissions: AppPerms, canWrite = true) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <ControlsClient
                    initialControls={[CONTROL]}
                    initialFilters={{}}
                    tenantSlug="acme"
                    permissions={{ canRead: true, canWrite, canAdmin: false, canAudit: false, canExport: true }}
                    appPermissions={appPermissions}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

/** Expand the control's tasks, open the task, and wait for its form to load. */
async function openTaskPanel(): Promise<HTMLElement> {
    await screen.findByText(CONTROL.name);
    // Let the mount-time reads settle, so the title clicked is still attached.
    await waitFor(() => {
        const paths = (global.fetch as jest.Mock).mock.calls.map(
            ([u]) => new URL(String(u), 'https://test.local').pathname,
        );
        expect(paths).toEqual(
            expect.arrayContaining(['/api/t/acme/controls/health-verdicts', '/api/t/acme/dashboard/trends']),
        );
    });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByTestId(`control-title-${CONTROL.id}`));
    const taskRow = await waitFor(() => {
        const el = document.querySelector(`[data-task-quickview="${TASK.id}"]`);
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    fireEvent.click(taskRow);
    const panel = await screen.findByTestId('task-edit-panel');
    // Loaded: a failed load locks the form too, which would pass the
    // assertions below for the wrong reason.
    await waitFor(() => expect(within(panel).getByDisplayValue(TASK.title)).toBeInTheDocument());
    return panel;
}

const assignee = (panel: HTMLElement) => panel.querySelector('#task-panel-assignee');

describe('Controls list — the Task quick view follows the keys its routes check', () => {
    it('a built-in Editor gets the evidence box and an enabled assignee picker', async () => {
        mount(editorWith());
        const panel = await openTaskPanel();

        expect(within(panel).getByTestId('evidence-upload-dropzone')).toBeInTheDocument();
        expect(assignee(panel)).toBeEnabled();
    });

    it('a custom role with tasks.edit but not evidence.upload gets no evidence box', async () => {
        mount(editorWith({ evidenceUpload: false }));
        const panel = await openTaskPanel();

        expect(within(panel).queryByTestId('evidence-upload-dropzone')).not.toBeInTheDocument();
        expect(assignee(panel)).toBeEnabled();
    });

    // The WIRING (#4389). Dropping `canWriteTier` from this page's call site
    // and restoring `canEditTasks && canUploadEvidence` left 13/13 green here
    // before this case existed, so the panel's fix was unprotected from the
    // page that configures it.
    it('a custom role with the write tier and evidence.upload but no tasks.edit still gets the evidence box', async () => {
        mount(slice('EDITOR', { tasksEdit: false, evidenceUpload: true }));
        const panel = await openTaskPanel();

        expect(within(panel).getByTestId('evidence-upload-dropzone')).toBeInTheDocument();
        // `/evidence/uploads` asks `evidence.upload` and the write tier;
        // `PATCH /tasks/:id` asks `tasks.edit`, which this viewer lacks.
        expect(panel.querySelector('#task-panel-title')).toBeDisabled();
    });

    it('a custom role with tasks.edit but not tasks.assign gets a locked assignee picker', async () => {
        mount(editorWith({ tasksAssign: false }));
        const panel = await openTaskPanel();

        expect(assignee(panel)).toBeDisabled();
        expect(within(panel).getByDisplayValue(TASK.title)).toBeEnabled();
        expect(within(panel).getByTestId('evidence-upload-dropzone')).toBeInTheDocument();
    });

    it('a custom role on a Reader base holding tasks.edit and tasks.assign gets a locked assignee picker', async () => {
        // `assertCanAssignTasks` asserts the write tier behind `tasks.assign`,
        // which a Reader base does not reach.
        mount(slice('READER', { tasksEdit: true, tasksAssign: true }), false);
        const panel = await openTaskPanel();

        expect(assignee(panel)).toBeDisabled();
    });
});
