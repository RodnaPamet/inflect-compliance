/**
 * The Vendors list, executed (#4462).
 *
 * Mounted THROUGH the server `page.tsx` (with its data and context reads
 * mocked), not by handing `VendorsClient` hand-written props — which
 * permissions the page passes down is part of what is under test, and a test
 * that wrote the props itself could not see that.
 *
 * What it holds, each as what a user gets rather than what the file says:
 *
 *   1. the create dialog offers no Active (a new vendor has no assessment, so
 *      the server refuses ACTIVE) and sends no status;
 *   2. a create refused because another live vendor has the name says so in
 *      the page's own words; any other refusal shows the server's reason;
 *   3. the write surface per ROLE, derived from the real
 *      `getPermissionsForRole` — each bulk verb, the create button and the
 *      `?create=1` deep link follow the rule the server applies to them, for
 *      built-in and custom roles;
 *   4. a refused bulk action shows the server's reason, and a selection over
 *      the routes' 100-row cap is refused before the request, by name.
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
        usePathname: () => '/t/acme/vendors',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
        __searchParams: searchParams,
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

// `toast.error` is captured: no Toaster is mounted, and a bulk outcome is
// reported only as a toast. Everything else in sonner stays real.
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

// The list renders a 50-row window and grows it on scroll, which jsdom
// cannot drive. The batch-cap test needs more than 100 rows on screen, so it
// opens the window; every other test keeps the real hook.
const mockRowWindow = { all: false };
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        useThresholdLoadMore: (rows: unknown[], opts?: unknown) =>
            mockRowWindow.all
                ? { visibleRows: rows, totalCount: rows.length, hasMore: false, loadMore: () => {}, reset: () => {} }
                : actual.useThresholdLoadMore(rows, opts),
    };
});

const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
}));
const mockListVendors = jest.fn();
jest.mock('@/app-layer/usecases/vendor', () => ({
    listVendors: (...a: unknown[]) => mockListVendors(...a),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import VendorRegisterPage from '@/app/t/[tenantSlug]/(app)/vendors/page';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';

const en = require('../../messages/en.json');
const V = en.vendors;

// ─── Fixtures ───────────────────────────────────────────────────────

function row(over: { id: string; name: string } & Record<string, unknown>) {
    return {
        status: 'ONBOARDING',
        criticality: 'MEDIUM',
        inherentRisk: null,
        nextReviewAt: null,
        contractRenewalAt: null,
        owner: null,
        isSubprocessor: false,
        ...over,
    };
}

const ALPHA = row({ id: 'v-alpha', name: 'Alpha Cloud' });
const BRAVO = row({ id: 'v-bravo', name: 'Bravo Payroll' });
const ROWS = [ALPHA, BRAVO];
const KPI = { total: 2, active: 0, critical: 0, reviewOverdue: 0 };
/** What the list endpoint (and the SSR read) returns; tests may widen it. */
let listRows: ReturnType<typeof row>[] = ROWS;

/** Per test: the answer to a POST, or null for the default 200 `{}`. */
let answerPost: (url: URL) => { status: number; body: unknown } | null = () => null;
/** Every POST the page made, with its parsed body. */
let posts: Array<{ path: string; body: unknown }> = [];

function installFetch() {
    posts = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://test.local');
        let status = 200;
        let body: unknown = {};
        if (init?.method === 'POST') {
            posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : null });
            const answered = answerPost(url);
            if (answered) ({ status, body } = answered);
        } else if (url.pathname === '/api/t/acme/vendors') {
            body = { rows: listRows, truncated: false, kpiCounts: KPI };
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

/** Mount the real server page as `ctx` — the same shape `getTenantCtx` builds. */
async function mount(ctx: RequestContext) {
    mockGetTenantCtx.mockResolvedValue(ctx);
    const element = await VendorRegisterPage({
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
    await screen.findByText(listRows[0].name);
    return view;
}

const mountAs = (role: Role) => mount(makeRequestContext(role));

/** A custom role: `base`'s coarse tier, with granular keys overridden. */
function customRole(base: Role, edit: (p: PermissionSet) => PermissionSet): RequestContext {
    return makeRequestContext(base, { appPermissions: edit(getPermissionsForRole(base)) });
}

/**
 * The labels the bulk bar's action picker offers, or null when the table has
 * no row selection at all (no checkboxes, so no bar).
 */
async function bulkActionLabels(): Promise<string[] | null> {
    const boxes = screen.queryAllByRole('checkbox');
    if (boxes.length === 0) return null;
    await act(async () => {
        fireEvent.click(boxes[0]);
    });
    const select = document.getElementById('bulk-action-select');
    if (!select) return null;
    fireEvent.click(select);
    const listbox = await screen.findByRole('listbox');
    return within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim() ?? '');
}

async function openCreateDialog() {
    await act(async () => {
        fireEvent.click(document.getElementById('new-vendor-btn') as HTMLElement);
    });
    return waitFor(() => {
        const el = document.getElementById('vendor-name-input');
        expect(el).not.toBeNull();
        return el as HTMLInputElement;
    });
}

async function submitCreate(name: string) {
    const input = await openCreateDialog();
    fireEvent.change(input, { target: { value: name } });
    await act(async () => {
        fireEvent.submit(document.getElementById('new-vendor-form') as HTMLFormElement);
    });
}

const createAlert = () =>
    waitFor(() => {
        const el = document.getElementById('new-vendor-error');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });

beforeEach(() => {
    window.localStorage.clear();
    answerPost = () => null;
    listRows = ROWS;
    mockRowWindow.all = false;
    mockToastError.mockReset();
    mockListVendors.mockReset();
    mockListVendors.mockResolvedValue(ROWS);
    const sp = jest.requireMock('next/navigation').__searchParams as URLSearchParams;
    sp.delete('create');
    installFetch();
});

// ─── 1. Creating offers no Active ───────────────────────────────────

describe('Vendors list — the create dialog offers no Active', () => {
    // Warm the module graph once so the first real test measures behaviour.
    beforeAll(async () => {
        installFetch();
        mockListVendors.mockResolvedValue(ROWS);
        try {
            const view = await mountAs('OWNER');
            view.unmount();
        } catch {
            /* warm-up only */
        }
    });

    it('shows Onboarding as the starting status, with no Active choice', async () => {
        await mountAs('EDITOR');
        await openCreateDialog();
        expect(document.getElementById('vendor-status-on-create')?.textContent).toBe(
            V.form.statusOnboarding,
        );
        // The Active / Onboarding radio group is gone, and so is any control
        // labelled Active.
        expect(document.getElementById('vendor-status-select')).toBeNull();
        expect(screen.queryByRole('radio')).toBeNull();
        expect(screen.queryByLabelText(V.form.statusActive)).toBeNull();
    });

    it('sends no status, so the server starts the vendor Onboarding', async () => {
        answerPost = (url) =>
            url.pathname === '/api/t/acme/vendors' ? { status: 201, body: { id: 'v-new' } } : null;
        await mountAs('EDITOR');
        await submitCreate('Charlie Analytics');
        await waitFor(() => expect(posts.some((p) => p.path === '/api/t/acme/vendors')).toBe(true));
        const sent = posts.find((p) => p.path === '/api/t/acme/vendors')!.body as Record<string, unknown>;
        expect(sent.name).toBe('Charlie Analytics');
        expect(sent).not.toHaveProperty('status');
    });
});

// ─── 2. A taken name is named ───────────────────────────────────────

describe('Vendors list — a create refused for a taken name says so', () => {
    it("says the name is taken in the page's words, not the server's", async () => {
        // The reason decides, not the sentence: the server's is English
        // whatever the reader's language, so the body carries a sentence the
        // page must NOT show.
        answerPost = (url) =>
            url.pathname === '/api/t/acme/vendors'
                ? {
                      status: 409,
                      body: {
                          error: {
                              code: 'CONFLICT',
                              message: 'A resource with that unique constraint already exists',
                              details: { reason: 'VENDOR_NAME_TAKEN' },
                          },
                      },
                  }
                : null;
        await mountAs('EDITOR');
        await submitCreate(ALPHA.name);
        expect((await createAlert()).textContent).toBe(V.form.nameTaken);
    });

    it("any other refusal shows the server's reason", async () => {
        answerPost = (url) =>
            url.pathname === '/api/t/acme/vendors'
                ? {
                      status: 403,
                      body: { error: { code: 'FORBIDDEN', message: 'plan_limit_exceeded: vendors' } },
                  }
                : null;
        await mountAs('EDITOR');
        await submitCreate('Delta Logistics');
        expect((await createAlert()).textContent).toBe('plan_limit_exceeded: vendors');
    });
});

// ─── 3. The write surface per role ──────────────────────────────────

describe('Vendors list — the write surface each role gets', () => {
    it.each(['OWNER', 'ADMIN'] as const)('%s can create and reach every bulk verb, Delete included', async (role) => {
        await mountAs(role);
        expect(document.getElementById('new-vendor-btn')).not.toBeNull();
        expect(await bulkActionLabels()).toEqual([V.bulk.setStatus, V.bulk.assignOwner, V.bulk.delete]);
    });

    it('EDITOR is NOT offered bulk Delete — the route requires admin.manage', async () => {
        await mountAs('EDITOR');
        expect(document.getElementById('new-vendor-btn')).not.toBeNull();
        expect(await bulkActionLabels()).toEqual([V.bulk.setStatus, V.bulk.assignOwner]);
    });

    it.each(['READER', 'AUDITOR', 'AI_ADMIN'] as const)(
        '%s gets no create button, no row selection and no bulk bar',
        async (role) => {
            await mountAs(role);
            expect(document.getElementById('new-vendor-btn')).toBeNull();
            expect(screen.queryAllByRole('checkbox')).toEqual([]);
            expect(await bulkActionLabels()).toBeNull();
        },
    );

    it('a custom role with vendors.create but not vendors.edit gets no create button', async () => {
        // The route admits it (vendors.create) and createVendor then refuses
        // it (vendors.edit), so the button offered a guaranteed refusal.
        await mount(
            customRole('READER', (p) => ({ ...p, vendors: { view: true, create: true, edit: false } })),
        );
        expect(document.getElementById('new-vendor-btn')).toBeNull();
        expect(await bulkActionLabels()).toBeNull();
    });

    it('a custom READER-based role with vendors.edit gets status + assign, not Delete', async () => {
        await mount(
            customRole('READER', (p) => ({ ...p, vendors: { view: true, create: false, edit: true } })),
        );
        expect(document.getElementById('new-vendor-btn')).toBeNull();
        expect(await bulkActionLabels()).toEqual([V.bulk.setStatus, V.bulk.assignOwner]);
    });

    it('a custom ADMIN-based role without admin.manage keeps status/assign but loses Delete', async () => {
        await mount(customRole('ADMIN', (p) => ({ ...p, admin: { ...p.admin, manage: false } })));
        expect(await bulkActionLabels()).toEqual([V.bulk.setStatus, V.bulk.assignOwner]);
    });
});

describe('Vendors list — `?create=1` opens the dialog only for a creator', () => {
    const setCreateParam = () =>
        (jest.requireMock('next/navigation').__searchParams as URLSearchParams).set('create', '1');

    it('READER following an old /vendors/new link gets no dialog', async () => {
        setCreateParam();
        await mountAs('READER');
        await act(async () => {
            await Promise.resolve();
        });
        expect(document.getElementById('new-vendor-form')).toBeNull();
    });

    it('EDITOR following the same link gets the dialog (positive companion)', async () => {
        setCreateParam();
        await mountAs('EDITOR');
        await waitFor(() => expect(document.getElementById('new-vendor-form')).not.toBeNull());
    });
});

// ─── 4. Bulk refusals say why ───────────────────────────────────────

/** Tick every visible row, pick Delete, apply, and confirm the dialog. */
async function bulkDeleteEverything() {
    const user = userEvent.setup();
    await act(async () => {
        fireEvent.click(screen.getAllByRole('checkbox')[0]);
    });
    await user.click(document.getElementById('bulk-action-select') as HTMLElement);
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: V.bulk.delete }));
    await user.click(document.getElementById('bulk-apply-btn') as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: en.common.table.confirmVerbDelete }));
}

describe('Vendors list — a refused bulk action says why', () => {
    it("shows the server's reason, not \"Bulk action failed.\"", async () => {
        answerPost = (url) =>
            url.pathname === '/api/t/acme/vendors/bulk/delete'
                ? { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Vendor is referenced by an open audit' } } }
                : null;
        await mountAs('OWNER');
        await bulkDeleteEverything();
        await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
        expect(mockToastError.mock.calls[0][0]).toBe('Vendor is referenced by an open audit');
    });

    it('falls back to the page\'s sentence when the server sends none', async () => {
        answerPost = (url) =>
            url.pathname === '/api/t/acme/vendors/bulk/delete' ? { status: 502, body: {} } : null;
        await mountAs('OWNER');
        await bulkDeleteEverything();
        await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
        expect(mockToastError.mock.calls[0][0]).toBe(V.bulk.failed);
    });

    it('a selection over the 100-row cap is refused by name, before any request', async () => {
        mockRowWindow.all = true;
        listRows = Array.from({ length: 101 }, (_, i) =>
            row({ id: `v-${String(i).padStart(3, '0')}`, name: `Vendor ${String(i).padStart(3, '0')}` }),
        );
        mockListVendors.mockResolvedValue(listRows);
        await mount(makeRequestContext('OWNER'));
        await bulkDeleteEverything();
        await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
        expect(mockToastError.mock.calls[0][0]).toBe(V.bulk.tooMany.replace('{max}', '100'));
        // The route would have answered "Invalid request payload".
        expect(posts.filter((p) => p.path.startsWith('/api/t/acme/vendors/bulk'))).toEqual([]);
    });
});
