/**
 * The Policies list page, mounted and driven (#4279).
 *
 * Every assertion is about what a user of the page gets, from the real
 * `PoliciesClient` with the permission sets the server page resolves:
 *
 *   - the write surface each role — and a CUSTOM role — is offered, which
 *     must equal what the routes accept;
 *   - the bulk Archive confirm describing an archive, not a deletion;
 *   - a refused bulk action saying the server's reason.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

// Mounting the whole page tree is a one-off module load that can run to tens
// of seconds on a loaded machine; every assertion is about WHAT renders.
jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

// `computePermissions` lives beside the DB-backed resolver; only the pure
// function is used here.
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
    }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
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
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// Hoisted: the factory below reads these lazily, so a test can swap the URL
// the page mounts on. ONE URLSearchParams identity per mount — a fresh one per
// call re-runs every effect that depends on it.
const mockNav = {
    searchParams: new URLSearchParams(),
    push: jest.fn(),
    replace: jest.fn(),
};
jest.mock('next/navigation', () => {
    const router = {
        push: (...a: unknown[]) => mockNav.push(...a),
        replace: (...a: unknown[]) => mockNav.replace(...a),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/policies',
        useSearchParams: () => mockNav.searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({ useToast: () => mockToast }));

import type { Role } from '@prisma/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PoliciesClient } from '@/app/t/[tenantSlug]/(app)/policies/PoliciesClient';
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole, parsePermissionsJson, type PermissionSet } from '@/lib/permissions';

type Props = React.ComponentProps<typeof PoliciesClient>;
type PolicyRow = Props['initialPolicies'][number];

const en = require('../../messages/en.json');
const P = en.policies;
const TABLE = en.common.table;

const DRAFT_POLICY: PolicyRow = {
    id: 'pol-draft',
    title: 'Acceptable Use Policy',
    status: 'DRAFT',
    category: 'HR',
    owner: null,
    currentVersion: null,
    lifecycleVersion: 1,
    nextReviewAt: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
};
const ALL_ROWS: PolicyRow[] = [DRAFT_POLICY];

const KPI = { total: 1, draft: 1, inReview: 0, approved: 0, overdueReview: 0, outstandingAck: 0 };

type Responder = (url: URL, init?: RequestInit) => { status: number; body: unknown } | undefined;
let respond: Responder = () => undefined;

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://test.local');
        const custom = respond(url, init);
        let status = 200;
        let body: unknown = {};
        if (custom) {
            ({ status, body } = custom);
        } else if (url.pathname === '/api/t/acme/policies') {
            body = { rows: ALL_ROWS, truncated: false, kpiCounts: KPI };
        }
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

/** What the server page hands the client for a membership. */
function accessFor(role: Role, customRoleJson?: unknown): Pick<Props, 'permissions' | 'appPermissions'> {
    const app: PermissionSet = customRoleJson === undefined
        ? getPermissionsForRole(role)
        : parsePermissionsJson(customRoleJson, role);
    return {
        permissions: computePermissions(role),
        appPermissions: { policies: app.policies, admin: { manage: app.admin.manage } },
    };
}

function mount(
    access: Pick<Props, 'permissions' | 'appPermissions'>,
    rows: PolicyRow[] = ALL_ROWS,
    extra: Partial<Pick<Props, 'initialFilters' | 'initialCategoryOptions'>> = {},
) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <PoliciesClient
                    initialPolicies={rows}
                    initialKpiCounts={KPI}
                    initialFilters={extra.initialFilters ?? {}}
                    initialCategoryOptions={extra.initialCategoryOptions}
                    tenantSlug="acme"
                    {...access}
                    translations={{ title: P.title, listDescription: P.listDescription }}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

/** Tick the header select-all, then open the bulk-action picker. */
async function openBulkPicker(): Promise<string[]> {
    const boxes = await screen.findAllByRole('checkbox');
    await act(async () => {
        fireEvent.click(boxes[0]);
    });
    const select = await waitFor(() => {
        const el = document.getElementById('bulk-action-select');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    fireEvent.click(select);
    const listbox = await screen.findByRole('listbox');
    return within(listbox).getAllByRole('option').map((o) => o.textContent?.trim() ?? '');
}

async function chooseBulkAction(label: string) {
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: label }));
    await act(async () => {
        fireEvent.click(document.getElementById('bulk-apply-btn') as HTMLElement);
    });
}

beforeEach(() => {
    mockNav.searchParams = new URLSearchParams();
    mockNav.push.mockReset();
    mockNav.replace.mockReset();
    Object.values(mockToast).forEach((fn) => fn.mockReset());
    respond = () => undefined;
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/policies');
    installFetch();
});

beforeAll(async () => {
    // Warm the module graph once so the first real test measures behaviour,
    // not module-load luck.
    installFetch();
    const view = mount(accessFor('OWNER'));
    try {
        await screen.findByText(DRAFT_POLICY.title);
    } catch {
        /* warm-up only */
    }
    view.unmount();
});

describe('Policies list — the write surface matches what the server accepts', () => {
    it('OWNER: create, select, and Assign owner + Archive + Delete', async () => {
        mount(accessFor('OWNER'));
        await screen.findByText(DRAFT_POLICY.title);
        expect(screen.getByRole('button', { name: P.list.addBtn })).toBeInTheDocument();
        expect(await openBulkPicker()).toEqual([P.bulk.assignOwner, P.bulk.archive, P.bulk.delete]);
    });

    it('EDITOR: create and Assign owner, never Archive or Delete', async () => {
        mount(accessFor('EDITOR'));
        await screen.findByText(DRAFT_POLICY.title);
        expect(screen.getByRole('button', { name: P.list.addBtn })).toBeInTheDocument();
        expect(await openBulkPicker()).toEqual([P.bulk.assignOwner]);
    });

    it.each(['READER', 'AUDITOR', 'AI_ADMIN'] as const)(
        '%s: no create button, no checkboxes, and a single click opens the policy',
        async (role) => {
            mount(accessFor(role));
            await screen.findByText(DRAFT_POLICY.title);
            expect(screen.queryByRole('button', { name: P.list.addBtn })).not.toBeInTheDocument();
            // No select column at all — not merely an empty bar.
            expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
            expect(document.getElementById('bulk-action-select')).toBeNull();

            // With selection on, a single click would TICK the row and only a
            // double-click would open it.
            // Re-query: the background revalidation re-renders the rows.
            const row = await waitFor(() => {
                const tr = screen.getByText(DRAFT_POLICY.title).closest('tr');
                expect(tr).not.toBeNull();
                return tr as HTMLElement;
            });
            fireEvent.click(row.querySelector('td:last-child') as HTMLElement);
            expect(mockNav.push).toHaveBeenCalledWith('/t/acme/policies/pol-draft');
        },
    );

    it('a custom role based on EDITOR without policies.create gets no create button', async () => {
        // The server refuses its POST (`policies.create` on the route AND in
        // assertCanCreatePolicy); the base role alone said "show it".
        mount(accessFor('EDITOR', { policies: { view: true, create: false, edit: true, approve: false } }));
        await screen.findByText(DRAFT_POLICY.title);
        expect(screen.queryByRole('button', { name: P.list.addBtn })).not.toBeInTheDocument();
        expect(await openBulkPicker()).toEqual([P.bulk.assignOwner]);
    });

    it('a custom role based on EDITOR without policies.edit gets no selection or bulk bar', async () => {
        // bulkAssignPolicy asserts policies.edit, so every bulk action would 403.
        mount(accessFor('EDITOR', { policies: { view: true, create: true, edit: false, approve: false } }));
        await screen.findByText(DRAFT_POLICY.title);
        expect(screen.getByRole('button', { name: P.list.addBtn })).toBeInTheDocument();
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });

    it('a custom role based on ADMIN without admin.manage is not offered Archive or Delete', async () => {
        // bulk/archive and bulk/delete require admin.manage AND policies.edit.
        mount(accessFor('ADMIN', { admin: { manage: false } }));
        await screen.findByText(DRAFT_POLICY.title);
        expect(await openBulkPicker()).toEqual([P.bulk.assignOwner]);
    });
});

describe('Policies list — bulk actions say what they do and why they failed', () => {
    it('the Archive confirm describes an archive, in warning tone, with an Archive button', async () => {
        mount(accessFor('ADMIN'));
        await screen.findByText(DRAFT_POLICY.title);
        await openBulkPicker();
        await chooseBulkAction(P.bulk.archive);

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(`${P.bulk.archive} 1 ${P.list.entityLabel}?`);
        expect(dialog).toHaveTextContent(P.bulk.archiveConfirmBody);
        expect(dialog).not.toHaveTextContent(TABLE.confirmDescription.replace('{noun}', P.list.entityLabel));
        expect(within(dialog).queryByRole('button', { name: TABLE.confirmVerbDelete })).toBeNull();
        expect(within(dialog).getByRole('button', { name: P.bulk.archive })).toBeInTheDocument();
    });

    it('a refused owner change shows the server\'s reason, not "Bulk action failed"', async () => {
        respond = (url) =>
            url.pathname.endsWith('/policies/bulk/assign')
                ? {
                      status: 400,
                      body: { error: { code: 'BAD_REQUEST', message: 'The owner is not an active member of this workspace.' } },
                  }
                : undefined;
        mount(accessFor('EDITOR'));
        await screen.findByText(DRAFT_POLICY.title);
        await openBulkPicker();
        await chooseBulkAction(P.bulk.assignOwner);

        await waitFor(() =>
            expect(mockToast.error).toHaveBeenCalledWith('The owner is not an active member of this workspace.'),
        );
        expect(mockToast.error).not.toHaveBeenCalledWith(P.bulk.failed);
    });

    it('a refused archive shows the server\'s reason', async () => {
        respond = (url) =>
            url.pathname.endsWith('/policies/bulk/archive')
                ? { status: 403, body: { error: { code: 'FORBIDDEN', message: 'You do not have permission to manage the policy lifecycle.' } } }
                : undefined;
        mount(accessFor('ADMIN'));
        await screen.findByText(DRAFT_POLICY.title);
        await openBulkPicker();
        await chooseBulkAction(P.bulk.archive);
        const dialog = await screen.findByRole('dialog');
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: P.bulk.archive }));
        });

        await waitFor(() =>
            expect(mockToast.error).toHaveBeenCalledWith('You do not have permission to manage the policy lifecycle.'),
        );
    });
});

describe('Policies list — the create dialog deep links', () => {
    it('`?create=1&template=1` (where /policies/templates lands) opens the dialog on "From template"', async () => {
        mockNav.searchParams = new URLSearchParams('create=1&template=1');
        mount(accessFor('EDITOR'));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText(P.new.titleTemplate)).toBeInTheDocument();
        expect(within(dialog).getByText(P.new.chooseTemplate)).toBeInTheDocument();
    });

    it('`?create=1` alone opens it on "New"', async () => {
        mockNav.searchParams = new URLSearchParams('create=1');
        mount(accessFor('EDITOR'));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText(P.new.titleBlank)).toBeInTheDocument();
        expect(within(dialog).queryByText(P.new.chooseTemplate)).toBeNull();
    });
});

describe('Policies list — the Version column shows the version the policy is on', () => {
    // Shapes the list query returns: `currentVersion` is the PUBLISHED pointer
    // (seeded as v1 when a policy is created with content), `versions` the
    // newest version only, and `lifecycleVersion` defaults to 1.
    const base = { ...DRAFT_POLICY, lifecycleVersion: 1 };
    const ROWS: PolicyRow[] = [
        { ...base, id: 'no-versions', title: 'No versions yet', currentVersion: null, versions: [] },
        { ...base, id: 'blank-drafts', title: 'Created blank, four drafts', currentVersion: null, versions: [{ versionNumber: 4 }] },
        {
            ...base,
            id: 'seeded-drafts',
            title: 'Created with content, three drafts',
            currentVersion: { id: 'v1', versionNumber: 1 },
            versions: [{ versionNumber: 3 }],
        },
        {
            ...base,
            id: 'live-with-revision',
            title: 'Published v2, revising v3',
            status: 'PUBLISHED',
            currentVersion: { id: 'v2', versionNumber: 2 },
            versions: [{ versionNumber: 3 }],
        },
    ];

    async function versionCells() {
        await screen.findByText('Published v2, revising v3');
        return Object.fromEntries(
            ROWS.map((r) => [r.id, document.querySelector(`[data-testid="policy-version-${r.id}"]`)?.textContent ?? '—']),
        );
    }

    it('a dash with no version, the newest while unpublished, the live one once published', async () => {
        respond = (url) =>
            url.pathname === '/api/t/acme/policies'
                ? { status: 200, body: { rows: ROWS, truncated: false, kpiCounts: KPI } }
                : undefined;
        mount(accessFor('READER'), ROWS);
        expect(await versionCells()).toEqual({
            'no-versions': '—',
            'blank-drafts': 'v4',
            'seeded-drafts': 'v3',
            'live-with-revision': 'v2',
        });
    });
});

describe('Policies list — a failed load says so', () => {
    const FAILED = { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'The policy list is unavailable.' } } };

    it('a failed filtered reload replaces the previous rows with the error', async () => {
        respond = (url) =>
            url.pathname === '/api/t/acme/policies' && url.searchParams.get('status') === 'DRAFT' ? FAILED : undefined;
        mount(accessFor('READER'));
        await screen.findByText(DRAFT_POLICY.title);

        // The Draft card applies status=DRAFT — a new query that fails.
        fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${P.list.kpiDraft}`) }));

        expect(await screen.findByText('The policy list is unavailable.')).toBeInTheDocument();
        // Not the previous result under the new filter.
        expect(screen.queryByText(DRAFT_POLICY.title)).toBeNull();
    });

    it('with nothing loaded before, the error shows — not "No policies match your filters"', async () => {
        window.history.replaceState({}, '', '/t/acme/policies?status=DRAFT');
        respond = (url) => (url.pathname === '/api/t/acme/policies' ? { status: 503, body: {} } : undefined);
        mount(accessFor('READER'), []);

        expect(await screen.findByText(P.list.loadError)).toBeInTheDocument();
        expect(screen.queryByText(P.list.emptyFilterTitle)).toBeNull();
    });
});

describe('Policies list — the Category facet', () => {
    it('with one category chosen, the facet still offers the tenant\'s other categories', async () => {
        // The rows are the FILTERED result — only HR policies — so options
        // derived from them alone offered only "HR", and a second category
        // could never be added.
        window.history.replaceState({}, '', '/t/acme/policies?category=HR');
        const categories = ['Compliance', 'HR', 'Operations'];
        respond = (url) =>
            url.pathname === '/api/t/acme/policies'
                ? { status: 200, body: { rows: ALL_ROWS, truncated: false, kpiCounts: KPI, categoryOptions: categories } }
                : undefined;
        mount(accessFor('READER'), ALL_ROWS, {
            initialFilters: { category: 'HR' },
            initialCategoryOptions: categories,
        });
        await screen.findByText(DRAFT_POLICY.title);

        // The active filter's pill — not the table's Category cell.
        const pill = await waitFor(() => {
            const el = screen.getAllByText('HR').find((n) => !n.closest('table'));
            expect(el).toBeDefined();
            return el as HTMLElement;
        });
        act(() => {
            fireEvent.click(pill);
        });
        expect(await screen.findByText('Compliance')).toBeInTheDocument();
        expect(screen.getByText('Operations')).toBeInTheDocument();
    });
});
