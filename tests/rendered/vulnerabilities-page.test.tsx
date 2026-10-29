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
 *      gave it, and a custom role sees only the controls its keys can use.
 */
import * as React from 'react';
import { configure, render, screen, within } from '@testing-library/react';
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

const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
}));
const mockListVulnerabilities = jest.fn();
jest.mock('@/app-layer/usecases/vulnerability', () => ({
    listVulnerabilities: (...a: unknown[]) => mockListVulnerabilities(...a),
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

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        let body: unknown = {};
        if (url.pathname === '/api/t/acme/vulnerabilities/status') {
            body = { syncEnabled: true, lastSyncedAt: null, assetsTotal: 1, assetsWithIdentity: 1 };
        } else if (url.pathname.includes('/members')) {
            body = [];
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

async function mount(ctx: RequestContext, rows = [vuln()]) {
    mockGetTenantCtx.mockResolvedValue(ctx);
    mockListVulnerabilities.mockResolvedValue(rows);
    const element = await VulnerabilitiesPage({
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
    await screen.findByText('CVE-2026-0001');
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
    installFetch();
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
