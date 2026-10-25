/**
 * Error states the help-guide reviews found missing (#4276, #4277, #4279):
 *
 *   - a list whose refresh failed kept its older rows with nothing said
 *     (SWR keeps the previous key's data);
 *   - the Evidence details panel said "Loading…" for ever when its load
 *     failed, because the loading branch was checked first;
 *   - the policy template picker said "No templates available" while the
 *     templates loaded and when the fetch failed.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(120_000);

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: {} }),
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
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
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
        usePathname: () => '/t/acme',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { AssetsClient } from '@/app/t/[tenantSlug]/(app)/assets/AssetsClient';
import { EvidenceDetailSheet } from '@/app/t/[tenantSlug]/(app)/evidence/EvidenceDetailSheet';
import { useNewPolicyForm } from '@/app/t/[tenantSlug]/(app)/policies/_form/useNewPolicyForm';
import { NewPolicyFields } from '@/app/t/[tenantSlug]/(app)/policies/_form/NewPolicyFields';

const en = require('../../messages/en.json');

const failing = (status = 500) =>
    jest.fn(async () => ({
        ok: false,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { code: 'INTERNAL', message: 'boom' } }),
        text: async () => JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }),
    })) as unknown as typeof fetch;

const wrap = (node: React.ReactNode) =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TooltipProvider>{node}</TooltipProvider>
        </SWRConfig>,
    );

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme');
});

it('Assets: a failed refresh says the rows on screen may be stale', async () => {
    global.fetch = failing();
    const asset = {
        id: 'asset-1',
        key: 'AST-1',
        name: 'Payroll database',
        type: 'DATA_STORE',
        status: 'ACTIVE',
        classification: null,
        owner: null,
        ownerUserId: null,
        ownerUser: null,
        location: null,
        criticality: null,
        _count: { controls: 0 },
        taskTotal: 0,
        taskDone: 0,
        openVulnCount: 0,
        maxVulnSeverity: null,
        deletedAt: null,
        deletedByUserId: null,
    } as unknown as React.ComponentProps<typeof AssetsClient>['initialAssets'][number];
    wrap(
        <AssetsClient
            initialAssets={[asset]}
            initialFilters={{}}
            tenantSlug="acme"
            permissions={{ canWrite: true, canAdmin: false }}
            translations={new Proxy({}, { get: (_t, k) => String(k) }) as React.ComponentProps<typeof AssetsClient>['translations']}
        />,
    );

    expect(await screen.findByText(en.common.ui.listRefreshFailed)).toBeTruthy();
    // The rows stay; the banner is beside them, not instead of them.
    expect(screen.getAllByText('Payroll database').length).toBeGreaterThan(0);
});

it('Evidence: a failed load of the details panel shows the error, not "Loading…"', async () => {
    global.fetch = failing(404);
    wrap(
        <EvidenceDetailSheet
            open
            setOpen={() => undefined}
            evidenceId="ev-gone"
            tenantSlug="acme"
            canWrite
            canAdmin={false}
            onEdit={() => undefined}
            onReview={() => undefined}
        />,
    );

    expect(await screen.findByText(en.evidence.detail.loadFailed)).toBeTruthy();
    expect(screen.queryByText(en.evidence.detail.loadingBody)).toBeNull();
});

function TemplatePicker() {
    const form = useNewPolicyForm({ isTemplateMode: true, onSuccess: () => undefined });
    return <NewPolicyFields form={form} />;
}

it('Policies: the template picker says it is loading, then that the load failed', async () => {
    let fail: (e: Error) => void = () => undefined;
    global.fetch = jest.fn(() => new Promise((_resolve, reject) => { fail = reject; })) as unknown as typeof fetch;
    wrap(<TemplatePicker />);

    expect(await screen.findByText(en.policies.new.templatesLoading)).toBeTruthy();
    expect(screen.queryByText(en.policies.new.templatesEmpty)).toBeNull();

    fail(new Error('network down'));

    expect(await screen.findByText(en.policies.new.templatesFailed)).toBeTruthy();
    expect(screen.queryByText(en.policies.new.templatesEmpty)).toBeNull();
});
