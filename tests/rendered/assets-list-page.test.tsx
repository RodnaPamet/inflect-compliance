/**
 * The Assets list, executed (#4276).
 *
 * Mounted THROUGH the server `page.tsx` (with its data and context reads
 * mocked), not by handing `AssetsClient` hand-written props — one of the
 * defects here was exactly which permissions the page passed down, and a
 * test that wrote the props itself could not see that.
 *
 * What it holds, each as what a user gets rather than what the file says:
 *
 *   1. the write surface per ROLE, derived from the real
 *      `getPermissionsForRole` — Delete is offered only to a role the
 *      bulk-delete route admits (`admin.manage`), and a custom role built on
 *      EDITOR without `assets.create` / `assets.edit` is offered neither the
 *      Asset button nor the bulk bar;
 *   2. the `/assets/new` → `?create=1` deep link opens the dialog only for a
 *      role that may create;
 *   3. the Deleted assets view lists the deleted rows with Restore / Purge for
 *      an admin, and without them for a custom admin-based role that lacks
 *      `admin.manage`;
 *   4. a failed load reads as an error, not as an empty register or as the
 *      previous query's rows;
 *   5. ↑/↓ in the preview panel walk the rows in the order the table shows;
 *   6. the Vulns badge keeps its count and opens the asset's own
 *      Vulnerabilities tab, which lists everything the count adds up;
 *   7. types, statuses and severities render as labels, not enum codes;
 *   8. a restore or create refused because the name is taken says so in the
 *      page's own words, and any other refused restore shows the server's
 *      reason rather than "try again" (#4324).
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import type { Role } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

// ─── Mocks (before imports) ─────────────────────────────────────────

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme' }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-1',
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
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en', __make: make };
});

jest.mock('next-intl/server', () => ({
    getTranslations: async (ns: string) => jest.requireMock('next-intl').__make(ns),
}));

jest.mock('next/navigation', () => {
    // ONE hoisted instance — `useCreateQueryParam` has it in an effect, and
    // a fresh object per call would re-render forever. Tests mutate it.
    const searchParams = new URLSearchParams();
    const router = {
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/assets',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
        __searchParams: searchParams,
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

// `toast.error` is captured: no Toaster is mounted, and the restore outcome
// is reported only as a toast. Everything else in sonner stays real.
const mockToastError = jest.fn();
jest.mock('sonner', () => {
    const actual = jest.requireActual('sonner');
    return {
        ...actual,
        toast: Object.assign((...a: unknown[]) => actual.toast(...a), {
            ...actual.toast,
            error: (...a: unknown[]) => mockToastError(...a),
        }),
    };
});

const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
}));
const mockListAssets = jest.fn();
jest.mock('@/app-layer/usecases/asset', () => ({
    listAssets: (...a: unknown[]) => mockListAssets(...a),
}));
jest.mock('@/lib/cache/ssr-cache', () => ({
    cachedSsrPayload: ({ compute }: { compute: () => unknown }) => compute(),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import AssetsPage from '@/app/t/[tenantSlug]/(app)/assets/page';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';

const en = require('../../messages/en.json');
const A = en.assets;

// ─── Fixtures ───────────────────────────────────────────────────────

function row(over: { id: string; name: string } & Record<string, unknown>) {
    return {
        key: over.id.toUpperCase(),
        type: 'SYSTEM',
        status: 'ACTIVE',
        classification: null,
        owner: null,
        ownerUserId: null,
        ownerUser: null,
        location: null,
        criticality: 'MEDIUM',
        dataResidency: null,
        externalRef: null,
        dependencies: null,
        businessProcesses: null,
        retention: null,
        retentionUntil: null,
        confidentiality: 3,
        integrity: 3,
        availability: 3,
        _count: { controls: 0 },
        taskTotal: 0,
        taskDone: 0,
        openVulnCount: 0,
        maxVulnSeverity: null,
        deletedAt: null,
        deletedByUserId: null,
        ...over,
    };
}

// FETCH order is deliberately not name order: Bravo, Alpha, Charlie.
const BRAVO = row({
    id: 'as-bravo',
    name: 'Bravo ledger',
    type: 'DATA_STORE',
    status: 'RETIRED',
    openVulnCount: 3,
    maxVulnSeverity: 'HIGH',
});
const ALPHA = row({ id: 'as-alpha', name: 'Alpha portal', type: 'PEOPLE_PROCESS' });
const CHARLIE = row({ id: 'as-charlie', name: 'Charlie gateway' });
const LIVE_ROWS = [BRAVO, ALPHA, CHARLIE];
const DELETED = row({
    id: 'as-gone',
    name: 'Decommissioned NAS',
    deletedAt: '2026-10-01T09:00:00.000Z',
    deletedByUserId: 'user-1',
});

/** Decides, per request, whether the list GET fails. */
let failList: (url: URL) => boolean = () => false;
/** Per test: the answer to a POST, or null for the default 200 `{}`. */
let answerPost: (url: URL) => { status: number; body: unknown } | null = () => null;

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://test.local');
        let status = 200;
        let body: unknown = {};
        const posted = init?.method === 'POST' ? answerPost(url) : null;
        if (posted) {
            ({ status, body } = posted);
        } else if (url.pathname === '/api/t/acme/assets') {
            if (failList(url)) {
                status = 500;
                body = { error: { code: 'INTERNAL', message: 'An error occurred' } };
            } else if (url.searchParams.get('includeDeleted') === 'true') {
                // The envelope the route returns (#4276 — it used to be a
                // bare array; see tests/unit/assets-list-route-envelope.test.ts).
                body = { rows: [DELETED], truncated: false };
            } else {
                body = {
                    rows: LIVE_ROWS,
                    truncated: false,
                    kpiCounts: { total: 3, active: 2, critical: 0, retired: 1 },
                };
            }
        } else if (url.pathname.includes('/members')) {
            body = [];
        }
        return {
            ok: status < 400,
            status,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

/**
 * Mount the real server page as `ctx`. The context is the SAME shape
 * `getTenantCtx` builds, so both the coarse tier and the granular keys are
 * whatever the permission model says — never a hand-written boolean.
 */
async function mount(ctx: RequestContext) {
    mockGetTenantCtx.mockResolvedValue(ctx);
    const element = await AssetsPage({
        params: Promise.resolve({ tenantSlug: 'acme' }),
        searchParams: Promise.resolve({}),
    });
    const view = render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <KeyboardShortcutProvider>{element}</KeyboardShortcutProvider>
            </TooltipProvider>
        </SWRConfig>,
    );
    await screen.findByText(ALPHA.name);
    return view;
}

const mountAs = (role: Role) => mount(makeRequestContext(role));

/** A custom role: `base`'s coarse tier, with granular keys overridden. */
function customRole(base: Role, edit: (p: PermissionSet) => PermissionSet): RequestContext {
    return makeRequestContext(base, { appPermissions: edit(getPermissionsForRole(base)) });
}

async function selectEveryRow() {
    const boxes = await screen.findAllByRole('checkbox');
    await act(async () => {
        fireEvent.click(boxes[0]);
    });
}

/** The labels the bulk bar's action picker offers, or null with no bar. */
async function bulkActionLabels(): Promise<string[] | null> {
    await selectEveryRow();
    const select = document.getElementById('bulk-action-select');
    if (!select) return null;
    fireEvent.click(select);
    const listbox = await screen.findByRole('listbox');
    return within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim() ?? '');
}

async function openViewsMenu() {
    const user = userEvent.setup();
    await user.click(document.getElementById('assets-views-menu') as HTMLElement);
    return user;
}

beforeEach(() => {
    window.localStorage.clear();
    failList = () => false;
    answerPost = () => null;
    mockToastError.mockReset();
    mockListAssets.mockReset();
    mockListAssets.mockResolvedValue(LIVE_ROWS);
    const sp = jest.requireMock('next/navigation').__searchParams as URLSearchParams;
    sp.delete('create');
    installFetch();
});

// ─── 1. The write surface per role ──────────────────────────────────

describe('Assets list — the write surface each role gets', () => {
    // Warm the module graph once so the first real test measures behaviour.
    beforeAll(async () => {
        installFetch();
        mockListAssets.mockResolvedValue(LIVE_ROWS);
        try {
            const view = await mountAs('OWNER');
            view.unmount();
        } catch {
            /* warm-up only */
        }
    });

    it.each(['OWNER', 'ADMIN'] as const)('%s can create and reach every bulk verb, Delete included', async (role) => {
        await mountAs(role);
        expect(document.getElementById('new-asset-btn')).not.toBeNull();
        expect(await bulkActionLabels()).toEqual([A.bulk.setStatus, A.bulk.assignOwner, A.bulk.delete]);
    });

    it('EDITOR is NOT offered bulk Delete — the route requires admin.manage', async () => {
        await mountAs('EDITOR');
        expect(document.getElementById('new-asset-btn')).not.toBeNull();
        // Status + owner are assets.edit verbs and stay; Delete would vanish the
        // rows under an Undo toast and bring them back with "Bulk action failed".
        expect(await bulkActionLabels()).toEqual([A.bulk.setStatus, A.bulk.assignOwner]);
    });

    it.each(['READER', 'AUDITOR'] as const)('%s gets no create button and no bulk bar', async (role) => {
        await mountAs(role);
        expect(document.getElementById('new-asset-btn')).toBeNull();
        expect(await bulkActionLabels()).toBeNull();
    });

    it('a custom role built on EDITOR without assets.create / assets.edit is offered neither', async () => {
        // The coarse tier says "writer" — it comes from the base role. The
        // routes check the custom role's own keys.
        await mount(
            customRole('EDITOR', (p) => ({ ...p, assets: { view: true, create: false, edit: false } })),
        );
        expect(document.getElementById('new-asset-btn')).toBeNull();
        expect(await bulkActionLabels()).toBeNull();
        await openViewsMenu();
        // The menu is open (its read-only destinations are there)…
        await waitFor(() => expect(document.getElementById('assets-coverage-link')).not.toBeNull());
        // …and Import, an assets.create route, is not.
        expect(document.getElementById('asset-import-btn')).toBeNull();
    });

    it('a custom ADMIN-based role without admin.manage keeps status/assign but loses Delete', async () => {
        await mount(
            customRole('ADMIN', (p) => ({ ...p, admin: { ...p.admin, manage: false } })),
        );
        expect(await bulkActionLabels()).toEqual([A.bulk.setStatus, A.bulk.assignOwner]);
    });
});

// ─── 2. The /assets/new deep link ───────────────────────────────────

describe('Assets list — `?create=1` opens the dialog only for a creator', () => {
    const setCreateParam = () =>
        (jest.requireMock('next/navigation').__searchParams as URLSearchParams).set('create', '1');

    it('READER following an old /assets/new link gets no dialog', async () => {
        setCreateParam();
        await mountAs('READER');
        // Give the mount effect its turn before asserting an absence.
        await act(async () => {
            await Promise.resolve();
        });
        expect(document.getElementById('new-asset-form')).toBeNull();
    });

    it('EDITOR following the same link gets the dialog (positive companion)', async () => {
        setCreateParam();
        await mountAs('EDITOR');
        await waitFor(() => expect(document.getElementById('new-asset-form')).not.toBeNull());
    });
});

// ─── 3. The Deleted assets view ─────────────────────────────────────

async function openDeletedView() {
    const user = await openViewsMenu();
    const toggle = await waitFor(() => {
        const el = document.getElementById('assets-show-deleted-toggle');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    await user.click(toggle);
}

describe('Assets list — the Deleted assets view', () => {
    it('lists the deleted rows with Restore and Purge for an ADMIN', async () => {
        await mountAs('ADMIN');
        await openDeletedView();
        await screen.findByText(DELETED.name);
        expect(screen.queryByText(A.deleted.emptyTitle)).toBeNull();
        expect(screen.getByRole('button', { name: A.deleted.restore })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: A.deleted.purge })).toBeInTheDocument();
    });

    it('shows a custom ADMIN-based role without admin.manage the rows, but not Restore/Purge', async () => {
        await mount(customRole('ADMIN', (p) => ({ ...p, admin: { ...p.admin, manage: false } })));
        await openDeletedView();
        await screen.findByText(DELETED.name);
        expect(screen.queryByRole('button', { name: A.deleted.restore })).toBeNull();
        expect(screen.queryByRole('button', { name: A.deleted.purge })).toBeNull();
    });
});

// ─── 4. A failed load ───────────────────────────────────────────────

describe('Assets list — a failed load reads as a failure', () => {
    it('a failed Deleted-view load shows the error, not the live rows or "No deleted assets"', async () => {
        failList = (url) => url.searchParams.get('includeDeleted') === 'true';
        await mountAs('ADMIN');
        await openDeletedView();
        await screen.findByText(A.list.loadError);
        expect(screen.queryByText(A.deleted.emptyTitle)).toBeNull();
        // SWR keeps the previous key's data (`keepPreviousData`); the live
        // rows must not be presented as the deleted view's answer.
        expect(screen.queryByText(ALPHA.name)).toBeNull();
    });

    it('a failed refresh of the list the server already rendered keeps its rows (positive companion)', async () => {
        failList = () => true;
        await mountAs('ADMIN');
        // The SSR rows are this key's own answer; a failed revalidation must
        // not replace a readable table with an error card.
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });
        expect(screen.getByText(ALPHA.name)).toBeInTheDocument();
        expect(screen.queryByText(A.list.loadError)).toBeNull();
    });
});

// ─── 5. ↑/↓ follow the table's order ────────────────────────────────

const panelFor = (name: string) =>
    screen.queryByRole('button', { name: en.common.ui.collapsePanel.replace('{title}', name) });

describe('Assets list — preview panel arrow keys', () => {
    it('ArrowDown moves to the next row ON SCREEN after a column sort', async () => {
        await mountAs('EDITOR');
        // Sort by name: the first click is descending → Charlie, Bravo, Alpha.
        const nameHeader = document.querySelector('th[data-column-id="name"] button') as HTMLElement;
        expect(nameHeader).not.toBeNull();
        await act(async () => {
            fireEvent.click(nameHeader);
        });
        await waitFor(() => {
            const titles = Array.from(document.querySelectorAll('[data-testid^="asset-title-"]')).map(
                (el) => el.textContent,
            );
            expect(titles).toEqual([CHARLIE.name, BRAVO.name, ALPHA.name]);
        });

        fireEvent.click(screen.getByTestId(`asset-title-${CHARLIE.id}`));
        await waitFor(() => expect(panelFor(CHARLIE.name)).not.toBeNull());

        // In FETCH order Charlie is last, so the old code clamped and stayed
        // put; on screen the next row is Bravo.
        fireEvent.keyDown(window, { key: 'ArrowDown' });
        await waitFor(() => expect(panelFor(BRAVO.name)).not.toBeNull());

        fireEvent.keyDown(window, { key: 'ArrowDown' });
        await waitFor(() => expect(panelFor(ALPHA.name)).not.toBeNull());

        fireEvent.keyDown(window, { key: 'ArrowUp' });
        await waitFor(() => expect(panelFor(BRAVO.name)).not.toBeNull());
    });
});

// ─── 6. The Vulns badge opens the list of what it counts ────────────

/** The href the Vulns badge carries — the URL the detail-page test opens. */
const VULNS_TAB_HREF = (id: string) => `/t/acme/assets/${id}?tab=vulnerabilities`;

describe('Assets list — the Vulns badge', () => {
    it("keeps its count and links to the asset's own Vulnerabilities tab", async () => {
        await mountAs('READER');
        // The count is unchanged: open CVE matches + open scanner findings.
        const badge = screen.getByRole('link', {
            name: A.openVulnsAria.replace('{count}', String(BRAVO.openVulnCount)),
        });
        expect(badge.textContent).toBe(String(BRAVO.openVulnCount));
        // Not the global /vulnerabilities page, which lists CVE matches only
        // (of every status) and so could not contain a scanner-finding count.
        // tests/rendered/asset-detail-tab-deep-link.test.tsx opens this URL.
        expect(badge.getAttribute('href')).toBe(VULNS_TAB_HREF(BRAVO.id));
    });
});

// ─── 7. Labels, not codes ───────────────────────────────────────────

describe('Assets list — types, statuses and severities are labels', () => {
    it('the Type cell shows the label the Type filter uses', async () => {
        await mountAs('READER');
        const typeCell = (id: string) => {
            const tr = screen.getByTestId(`asset-title-${id}`).closest('tr') as HTMLElement;
            return (tr.querySelector('td[data-column-id="type"]') ?? tr).textContent ?? '';
        };
        expect(typeCell(BRAVO.id)).toContain(A.filterEnums.type.DATA_STORE);
        expect(typeCell(ALPHA.id)).toContain(A.filterEnums.type.PEOPLE_PROCESS);
        expect(screen.queryByText('DATA STORE')).toBeNull();
        expect(screen.queryByText('PEOPLE PROCESS')).toBeNull();
    });

    it('the preview panel shows the type, status and top severity as labels', async () => {
        await mountAs('READER');
        fireEvent.click(screen.getByTestId(`asset-title-${BRAVO.id}`));
        await waitFor(() => expect(panelFor(BRAVO.name)).not.toBeNull());
        // The docked rail (jsdom reports ≥xl), which holds only the panel.
        const panel = screen.getByTestId('aside-panel-docked');
        expect(within(panel).getByText(A.detail.fullView)).toBeInTheDocument();
        const text = panel.textContent ?? '';

        expect(text).toContain(`${BRAVO.key} · ${A.filterEnums.type.DATA_STORE}`);
        expect(text).toContain(A.statusOption.RETIRED);
        expect(text).toContain(`3 · ${A.vulnSeverity.HIGH}`);
        for (const code of ['DATA STORE', 'RETIRED', 'HIGH']) {
            expect({ code, shown: new RegExp(`\\b${code}\\b`).test(text) }).toEqual({ code, shown: false });
        }
    });

    it('the create form offers the same type labels', async () => {
        await mountAs('EDITOR');
        await act(async () => {
            fireEvent.click(document.getElementById('new-asset-btn') as HTMLElement);
        });
        const trigger = await waitFor(() => {
            const el = document.getElementById('asset-type-select');
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });
        fireEvent.click(trigger);
        const listbox = await screen.findByRole('listbox');
        const offered = within(listbox)
            .getAllByRole('option')
            .map((o) => o.textContent?.trim() ?? '');
        // The form's options are the filter's labels — it offered the codes
        // ("DATA STORE", "PEOPLE PROCESS") while the filter said otherwise.
        expect([...offered].sort()).toEqual(
            Object.values(A.filterEnums.type as Record<string, string>).sort(),
        );
    });
});

// ─── 8. A taken name is named (#4324) ───────────────────────────────

/** The refusal the server sends for a taken name (`src/lib/asset-name-taken.ts`). */
function nameTaken(message: string) {
    return {
        status: 409,
        body: { error: { code: 'CONFLICT', message, details: { reason: 'ASSET_NAME_TAKEN' } } },
    };
}

async function clickRestore() {
    await openDeletedView();
    await screen.findByText(DELETED.name);
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: A.deleted.restore }));
    });
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    return mockToastError.mock.calls[0][0] as string;
}

describe('Assets list — a taken name is named', () => {
    it('a restore refused because another asset took the name says so, not "try again"', async () => {
        answerPost = (url) =>
            url.pathname === `/api/t/acme/assets/${DELETED.id}/restore`
                ? nameTaken('Cannot restore: another asset now has this name. Rename that asset first, then retry.')
                : null;
        await mountAs('ADMIN');
        const shown = await clickRestore();
        expect(shown).toBe(A.deleted.restoreNameTaken.replace('{name}', DELETED.name));
        expect(shown).not.toBe(A.deleted.restoreFailed);
    });

    it("any other refused restore shows the server's reason", async () => {
        answerPost = (url) =>
            url.pathname.endsWith('/restore')
                ? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Asset is not deleted' } } }
                : null;
        await mountAs('ADMIN');
        expect(await clickRestore()).toBe('Asset is not deleted');
    });

    it("the new-asset dialog says the name is taken in the page's words, not the server's", async () => {
        // The reason decides, not the sentence: the server's is English
        // whatever the reader's language.
        answerPost = (url) =>
            url.pathname === '/api/t/acme/assets'
                ? nameTaken('A resource with that unique constraint already exists')
                : null;
        await mountAs('EDITOR');
        await act(async () => {
            fireEvent.click(document.getElementById('new-asset-btn') as HTMLElement);
        });
        const input = await waitFor(() => {
            const el = document.getElementById('asset-name-input');
            expect(el).not.toBeNull();
            return el as HTMLInputElement;
        });
        fireEvent.change(input, { target: { value: ALPHA.name } });
        await act(async () => {
            fireEvent.submit(document.getElementById('new-asset-form') as HTMLFormElement);
        });
        const alert = await waitFor(() => {
            const el = document.getElementById('new-asset-error');
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });
        expect(alert.textContent).toBe(A.form.nameTaken);
    });
});
