/**
 * The Vulnerabilities page, executed (#4465).
 *
 * Mounted THROUGH the server `page.tsx`, with its context and data reads
 * mocked, so the permissions it passes down are the ones under test rather
 * than props the test wrote.
 *
 * What it holds, each as what a user gets:
 *
 *   1. every control follows its route's gate — the coarse tier AND the
 *      route's granular keys — so a built-in role sees what its coarse tier
 *      gave it, and a custom role sees only the controls its keys can use;
 *   2. a refused action shows the server's reason — in the page's own words
 *      when it is a refusal the page can name — and the generic fallbacks
 *      carry no English interpolated into a translated sentence;
 *   3. the Severity and Matched columns show labels, not stored codes;
 *   4. a capped list says so, and the filters it tells you to refine are
 *      applied to the read, not only to the first 500 rows in the browser;
 *   5. a list opened from an asset says it is that asset's, offers the way
 *      back to every vulnerability, and does not claim "your assets" when
 *      that one asset has none.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { Role } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';

jest.setTimeout(120_000);
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
                    s = s.replace(new RegExp(`\\{${p}(, number)?\\}`, 'g'), String(val));
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
        usePathname: () => '/t/acme/vulnerabilities',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

// Toasts are captured: no Toaster is mounted, and an action's outcome is
// reported only as a toast. Everything else in sonner stays real.
const mockToastError = jest.fn();
const mockToastSuccess = jest.fn();
jest.mock('sonner', () => {
    const actual = jest.requireActual('sonner');
    return {
        ...actual,
        toast: Object.assign((...a: unknown[]) => actual.toast(...a), {
            ...actual.toast,
            error: (...a: unknown[]) => mockToastError(...a),
            success: (...a: unknown[]) => mockToastSuccess(...a),
        }),
    };
});

const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
}));
const mockListVulnerabilities = jest.fn();
jest.mock('@/app-layer/usecases/vulnerability', () => ({
    VULN_STATUSES: ['OPEN', 'MITIGATING', 'MITIGATED', 'ACCEPTED', 'FALSE_POSITIVE'],
    listVulnerabilitiesForPage: (...a: unknown[]) => mockListVulnerabilities(...a),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import VulnerabilitiesPage from '@/app/t/[tenantSlug]/(app)/vulnerabilities/page';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';

const en = require('../../messages/en.json');
const V = en.vulnerabilities;

// ─── Fixtures ───────────────────────────────────────────────────────

function vuln(over: Record<string, unknown> = {}) {
    return {
        id: 'v-1',
        status: 'OPEN',
        matchedVia: 'CPE',
        cveId: 'CVE-2026-0001',
        ownerUserId: null,
        ownerUser: null,
        remediationDueAt: null,
        remediationTaskId: null,
        remediationTask: null,
        note: null,
        cve: {
            id: 'CVE-2026-0001',
            cvssScore: 9.8,
            cvssSeverity: 'CRITICAL',
            summary: 'Remote code execution',
            references: [],
        },
        asset: { id: 'a-1', key: 'AST-1', name: 'Web server' },
        ...over,
    };
}

/** Per test: the answer to a write (POST / PATCH), or null for a 200 `{}`. */
let answerWrite: (url: URL, method: string) => { status: number; body: unknown } | null = () => null;

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://test.local');
        let status = 200;
        let body: unknown = {};
        const method = init?.method ?? 'GET';
        const written = method !== 'GET' ? answerWrite(url, method) : null;
        if (written) {
            ({ status, body } = written);
        } else if (url.pathname === '/api/t/acme/vulnerabilities/status') {
            body = { syncEnabled: true, lastSyncedAt: null, assetsTotal: 1, assetsWithIdentity: 1 };
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

interface MountOptions {
    truncated?: boolean;
    scopeAsset?: { id: string; key: string | null; name: string } | null;
    searchParams?: Record<string, string>;
    /** Wait for this text before returning (default: the first row's CVE). */
    ready?: string;
}

async function mount(ctx: RequestContext, rows = [vuln()], opts: MountOptions = {}) {
    mockGetTenantCtx.mockResolvedValue(ctx);
    mockListVulnerabilities.mockResolvedValue({
        rows,
        truncated: opts.truncated ?? false,
        cap: 500,
        scopeAsset: opts.scopeAsset ?? null,
    });
    const element = await VulnerabilitiesPage({
        params: Promise.resolve({ tenantSlug: 'acme' }),
        searchParams: Promise.resolve(opts.searchParams ?? {}),
    });
    const view = render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <KeyboardShortcutProvider>{element}</KeyboardShortcutProvider>
            </TooltipProvider>
        </SWRConfig>,
    );
    await screen.findByText(opts.ready ?? (rows[0] as { cve: { id: string } } | undefined)?.cve.id ?? V.title);
    return view;
}

/** A custom role: `base`'s coarse tier, with granular keys overridden. */
function customRole(base: Role, edit: (p: PermissionSet) => PermissionSet): RequestContext {
    return makeRequestContext(base, { appPermissions: edit(getPermissionsForRole(base)) });
}

function off<D extends keyof PermissionSet>(domain: D, flag: keyof PermissionSet[D]) {
    return (p: PermissionSet): PermissionSet => ({ ...p, [domain]: { ...p[domain], [flag]: false } });
}

const button = (name: string) => screen.queryByRole('button', { name });

/** The write controls on the page, by what each says. */
function surface() {
    // No <main> here — the app layout supplies it, and this mounts the page alone.
    const main = document.body;
    return {
        toRisk: within(main).queryByRole('button', { name: V.toRisk }) !== null,
        toFinding: within(main).queryByRole('button', { name: V.toFinding }) !== null,
        createTask: within(main).queryByRole('button', { name: V.createTask }) !== null,
        linkCve: button(V.linkCve) !== null,
        // The Combobox trigger is `role="combobox"`, named by its aria-label.
        statusPicker: within(main).queryByRole('combobox', { name: V.colStatus }) !== null,
    };
}

const ALL = { toRisk: true, toFinding: true, createTask: true, linkCve: true, statusPicker: true };
const NONE = { toRisk: false, toFinding: false, createTask: false, linkCve: false, statusPicker: false };

beforeEach(() => {
    window.localStorage.clear();
    mockListVulnerabilities.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
    answerWrite = () => null;
    installFetch();
});

async function click(name: string) {
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name }));
    });
}

const refusal = (status: number, code: string, message: string, reason?: string) => ({
    status,
    body: { error: { code, message, ...(reason ? { details: { reason } } : {}) } },
});

// ─── 1. Each control follows its route's gate ───────────────────────

describe('Vulnerabilities — the write surface each role gets', () => {
    it.each(['OWNER', 'ADMIN', 'EDITOR'] as const)('%s gets every control (unchanged)', async (role) => {
        await mount(makeRequestContext(role));
        expect(surface()).toEqual(ALL);
    });

    it.each(['AUDITOR', 'READER', 'AI_ADMIN'] as const)('%s gets none (unchanged)', async (role) => {
        await mount(makeRequestContext(role));
        expect(surface()).toEqual(NONE);
    });

    it('a custom EDITOR role without assets.edit gets none — every vulnerability route asks it', async () => {
        await mount(customRole('EDITOR', off('assets', 'edit')));
        expect(surface()).toEqual(NONE);
    });

    it('a custom EDITOR role without risks.create keeps everything but To Risk', async () => {
        await mount(customRole('EDITOR', off('risks', 'create')));
        expect(surface()).toEqual({ ...ALL, toRisk: false });
    });

    it('a custom EDITOR role without tasks.edit is not offered Create task (the route refuses it)', async () => {
        await mount(customRole('EDITOR', off('tasks', 'edit')));
        expect(surface()).toEqual({ ...ALL, createTask: false });
    });

    it('a custom EDITOR role without tasks.create is not offered Create task', async () => {
        await mount(customRole('EDITOR', off('tasks', 'create')));
        expect(surface()).toEqual({ ...ALL, createTask: false });
    });
});

// ─── 2. A refused action says why ───────────────────────────────────

describe('Vulnerabilities — a refused action shows its reason', () => {
    it('Create task refused REMEDIATION_TASK_EXISTS reads in the page\'s own words', async () => {
        answerWrite = (url) =>
            url.pathname.endsWith('/remediation-task')
                ? refusal(409, 'CONFLICT', 'A remediation task already exists for this vulnerability.', 'REMEDIATION_TASK_EXISTS')
                : null;
        await mount(makeRequestContext('EDITOR'));
        await click(V.createTask);
        await waitFor(() => expect(mockToastError).toHaveBeenCalled());
        expect(mockToastError.mock.calls[0][0]).toBe(V.refusalRemediationTaskExists);
    });

    it('To Risk refused shows the server\'s message', async () => {
        answerWrite = (url) =>
            url.pathname.endsWith('/convert-to-risk') ? refusal(404, 'NOT_FOUND', 'Vulnerability not found') : null;
        await mount(makeRequestContext('EDITOR'));
        await click(V.toRisk);
        await waitFor(() => expect(mockToastError).toHaveBeenCalled());
        expect(mockToastError.mock.calls[0][0]).toBe('Vulnerability not found');
    });

    it('To Finding refused with no message falls back to a sentence with no English word spliced in', async () => {
        answerWrite = (url) => (url.pathname.endsWith('/convert-to-finding') ? { status: 500, body: {} } : null);
        await mount(makeRequestContext('EDITOR'));
        await click(V.toFinding);
        await waitFor(() => expect(mockToastError).toHaveBeenCalled());
        expect(mockToastError.mock.calls[0][0]).toBe(V.convertFindingFailed);
        // The old key interpolated the hard-coded word 'finding' into a translated sentence.
        expect(V.convertFindingFailed).not.toMatch(/\{/);
        expect(V.convertRiskFailed).not.toMatch(/\{/);
        expect(V).not.toHaveProperty('convertFailed');
    });

    it('a refused triage edit shows the server\'s message, not "Could not update"', async () => {
        answerWrite = (url, method) =>
            method === 'PATCH' ? refusal(400, 'BAD_REQUEST', 'Owner must be an active member of this tenant') : null;
        await mount(makeRequestContext('EDITOR'));
        const picker = screen.getByRole('combobox', { name: V.colStatus });
        await act(async () => {
            fireEvent.click(picker);
        });
        const option = await screen.findByRole('option', { name: V.filterEnums.status.MITIGATED });
        await act(async () => {
            fireEvent.click(option);
        });
        await waitFor(() => expect(mockToastError).toHaveBeenCalled());
        expect(mockToastError.mock.calls[0][0]).toBe('Owner must be an active member of this tenant');
    });
});

// ─── 3. Codes render as labels ──────────────────────────────────────

describe('Vulnerabilities — stored codes render as labels', () => {
    it('Severity shows the localised label and Matched says how the match was made', async () => {
        await mount(makeRequestContext('READER'), [
            vuln(),
            vuln({
                id: 'v-2',
                matchedVia: 'MANUAL',
                cveId: 'CVE-2026-0002',
                cve: { id: 'CVE-2026-0002', cvssScore: 5.0, cvssSeverity: 'MEDIUM', summary: 's', references: [] },
            }),
        ]);
        const first = screen.getByText('CVE-2026-0001').closest('tr') as HTMLElement;
        const second = screen.getByText('CVE-2026-0002').closest('tr') as HTMLElement;
        expect(within(first).getByText(V.filterEnums.severity.CRITICAL)).toBeTruthy();
        expect(within(first).getByText(V.matchedViaLabels.CPE)).toBeTruthy();
        expect(within(second).getByText(V.filterEnums.severity.MEDIUM)).toBeTruthy();
        expect(within(second).getByText(V.matchedViaLabels.MANUAL)).toBeTruthy();
        for (const code of ['CRITICAL', 'MEDIUM', 'CPE', 'MANUAL']) {
            expect(within(first.parentElement as HTMLElement).queryByText(code)).toBeNull();
        }
    });
});

// ─── 4. A capped list says so ───────────────────────────────────────

describe('Vulnerabilities — the 500-row cap', () => {
    it('shows the truncation notice when the read had more rows than the cap', async () => {
        await mount(makeRequestContext('READER'), [vuln()], { truncated: true });
        const notice = screen.getByTestId('list-truncation-banner');
        expect(notice.textContent).toContain('500');
    });

    it('shows no notice when the list is complete', async () => {
        await mount(makeRequestContext('READER'));
        expect(screen.queryByTestId('list-truncation-banner')).toBeNull();
    });

    it('the status and severity filters in the URL reach the read; unknown values are dropped', async () => {
        await mount(makeRequestContext('READER'), [vuln()], {
            searchParams: { status: 'OPEN,MITIGATING,BOGUS', severity: 'CRITICAL,NOPE' },
        });
        expect(mockListVulnerabilities).toHaveBeenCalledTimes(1);
        expect(mockListVulnerabilities.mock.calls[0][1]).toEqual({
            assetId: undefined,
            statuses: ['OPEN', 'MITIGATING'],
            severities: ['CRITICAL'],
        });
    });
});

// ─── 5. A list opened from an asset says whose it is ────────────────

describe('Vulnerabilities — opened from an asset', () => {
    const ASSET = { id: 'a-1', key: 'AST-1', name: 'Web server' };

    it('names the asset and links back to every vulnerability, keeping the filters', async () => {
        // The filter context reads its state from the address bar.
        window.history.replaceState(null, '', '/t/acme/vulnerabilities?assetId=a-1&status=OPEN');
        await mount(makeRequestContext('READER'), [vuln()], {
            scopeAsset: ASSET,
            searchParams: { assetId: 'a-1', status: 'OPEN' },
        });
        window.history.replaceState(null, '', '/');
        expect(mockListVulnerabilities.mock.calls[0][1]).toMatchObject({ assetId: 'a-1' });
        const notice = document.getElementById('vuln-asset-scope') as HTMLElement;
        expect(notice.textContent).toContain(V.scopedToAsset.replace('{asset}', 'AST-1 · Web server'));
        const back = document.getElementById('vuln-asset-scope-clear') as HTMLAnchorElement;
        expect(back.textContent).toBe(V.showAllVulnerabilities);
        // Same page, same filters, no asset.
        expect(back.getAttribute('href')).toBe('/t/acme/vulnerabilities?status=OPEN');
    });

    it('an asset with no matches gets its own empty state, not "No vulnerabilities matched your assets"', async () => {
        await mount(makeRequestContext('READER'), [], {
            scopeAsset: ASSET,
            searchParams: { assetId: 'a-1' },
            ready: V.emptyScopedTitle,
        });
        expect(screen.queryByText(V.emptyCleanTitle)).toBeNull();
        expect(screen.getByText(V.emptyScopedDesc)).toBeTruthy();
    });

    it('an id that names no live asset says so instead of naming one', async () => {
        await mount(makeRequestContext('READER'), [], {
            scopeAsset: null,
            searchParams: { assetId: 'gone' },
            ready: V.emptyScopedTitle,
        });
        expect((document.getElementById('vuln-asset-scope') as HTMLElement).textContent).toContain(V.scopedToMissingAsset);
    });

    it('an unscoped list shows no asset notice', async () => {
        await mount(makeRequestContext('READER'));
        expect(document.getElementById('vuln-asset-scope')).toBeNull();
    });
});

// ─── 6. No select column without bulk actions ───────────────────────

describe('Vulnerabilities — no row selection', () => {
    it('renders no checkboxes: the page has no bulk action for them to drive', async () => {
        await mount(makeRequestContext('OWNER'));
        expect(screen.queryAllByRole('checkbox')).toEqual([]);
    });
});
