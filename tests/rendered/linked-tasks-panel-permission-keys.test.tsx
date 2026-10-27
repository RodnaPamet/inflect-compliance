/**
 * `LinkedTasksPanel`'s two affordances ask two different keys (#4415).
 *
 * The panel took one `canWrite` and used it for both a task CREATE — whose
 * POST the server gates on `tasks.create` (`assertCanCreateTask`) — and row
 * selection, which is what reveals the bulk actions, gated on `tasks.edit`
 * (`assertCanWriteTasks`). The two are separately grantable, so a custom role
 * holding one without the other was offered an affordance it would be refused.
 *
 * `canCreateTasks` and `canEditTasks` both DEFAULT to `canWrite`, which is what
 * keeps the callers that have not been converted behaving exactly as before —
 * the last two cases here are that default.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

// The Tasks tab is now a <DataTable> whose row-click navigates via
// the Next app-router. LinkedTasksPanel also statically imports
// NewTaskModal, which pulls router hooks at module load. Mock
// next/navigation so the import resolves and useRouter() doesn't trip
// the "expected app router to be mounted" invariant under jsdom.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/risks/r-1',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

// NewTaskModal (statically imported by the panel) pulls tenant-context
// hooks at module load — stub them so the import resolves under jsdom.
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantContext: () => ({ tenantSlug: 'acme' }),
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

// next-intl is ESM (jest can't parse it); mock it to resolve real en.json
// values so LinkedTasksPanel's NewTaskModal child renders the English copy.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key
                .split('.')
                .reduce((o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined, en[ns]);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});

import LinkedTasksPanel from '@/components/LinkedTasksPanel';

const tenantHref = (p: string) => `/t/acme${p}`;
const WAIT = { timeout: 10_000 };

function serveOneTask() {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
        async () =>
            ({
                ok: true,
                json: async () => ({
                    rows: [
                        {
                            id: 'task-1',
                            title: 'Triage finding',
                            status: 'OPEN',
                            severity: 'HIGH',
                            dueDate: null,
                            updatedAt: null,
                            assignee: null,
                        },
                    ],
                }),
            }) as Response,
    );
}

const mount = (props: Record<string, unknown>) =>
    render(
        <LinkedTasksPanel
            apiBase="/api/t/acme"
            entityType="CONTROL"
            entityId="ctrl-1"
            tenantHref={tenantHref}
            {...props}
        />,
    );

const createButton = () => screen.queryByTestId('linked-task-create-btn');
const checkboxes = () => screen.queryAllByRole('checkbox');

beforeEach(serveOneTask);
afterEach(() => jest.restoreAllMocks());

describe('LinkedTasksPanel — the create and the bulk actions ask different keys', () => {
    it('tasks.edit without tasks.create: selection, no create', async () => {
        mount({ canWrite: true, canCreateTasks: false, canEditTasks: true });
        await waitFor(() => expect(screen.getByText('Triage finding')).toBeInTheDocument(), WAIT);

        expect(createButton()).not.toBeInTheDocument();
        expect(checkboxes().length).toBeGreaterThan(0);
    });

    it('tasks.create without tasks.edit: create, no selection', async () => {
        mount({ canWrite: true, canCreateTasks: true, canEditTasks: false });
        await waitFor(() => expect(screen.getByText('Triage finding')).toBeInTheDocument(), WAIT);

        expect(createButton()).toBeInTheDocument();
        expect(checkboxes()).toHaveLength(0);
    });

    it('both keys: both affordances — the control case', async () => {
        mount({ canWrite: true, canCreateTasks: true, canEditTasks: true });
        await waitFor(() => expect(screen.getByText('Triage finding')).toBeInTheDocument(), WAIT);

        expect(createButton()).toBeInTheDocument();
        expect(checkboxes().length).toBeGreaterThan(0);
    });

    it('neither key: a read-only table', async () => {
        mount({ canWrite: true, canCreateTasks: false, canEditTasks: false });
        await waitFor(() => expect(screen.getByText('Triage finding')).toBeInTheDocument(), WAIT);

        expect(createButton()).not.toBeInTheDocument();
        expect(checkboxes()).toHaveLength(0);
    });

    it('an unconverted caller passing only canWrite keeps BOTH, as before', async () => {
        mount({ canWrite: true });
        await waitFor(() => expect(screen.getByText('Triage finding')).toBeInTheDocument(), WAIT);

        expect(createButton()).toBeInTheDocument();
        expect(checkboxes().length).toBeGreaterThan(0);
    });

    it('and one passing canWrite false keeps NEITHER', async () => {
        mount({ canWrite: false });
        await waitFor(() => expect(screen.getByText('Triage finding')).toBeInTheDocument(), WAIT);

        expect(createButton()).not.toBeInTheDocument();
        expect(checkboxes()).toHaveLength(0);
    });
});
