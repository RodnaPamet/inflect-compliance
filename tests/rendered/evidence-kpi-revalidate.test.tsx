/**
 * The evidence KPI cards refresh after a change (#5165).
 *
 * The tiles and the archived-aware empty state read the retention aggregate
 * (`/evidence/retention`), which the list invalidation's URL matcher never
 * reached, so they kept the counts from page load after any create, review,
 * archive or delete.
 */
import * as React from 'react';
import { act, configure, fireEvent, screen, waitFor } from '@testing-library/react';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

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
    useMoneyFormatter: () => (v: number | null | undefined) => (v == null ? '' : String(v)),
    useModules: () => ({}),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        if (cache.has(ns)) return cache.get(ns);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            const plural = v.replace(
                /\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
                (_m, name, one, other) => {
                    const n = Number(values?.[name]);
                    return (n === 1 ? one : other).replace('#', String(n));
                },
            );
            return plural.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockSearchParams = new URLSearchParams();
jest.mock('next/navigation', () => {
    const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/evidence',
        useSearchParams: () => mockSearchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/LinkedTasksPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/user-combobox', () => ({ UserCombobox: () => null }));
// The control picker is a plain input here: the test is about what happens
// after a control is chosen, not about the picker.
jest.mock('@/components/ui/entity-picker', () => ({
    EntityPicker: ({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) => (
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    ),
}));

const toastError = jest.fn();
jest.mock('sonner', () => {
    const actual = jest.requireActual('sonner');
    return {
        ...actual,
        toast: Object.assign((...a: unknown[]) => actual.toast(...a), {
            ...actual.toast,
            error: (...a: unknown[]) => toastError(...a),
        }),
    };
});

import {
    COARSE,
    GRANTS,
    enText,
    evidenceRow,
    installEvidenceFetch,
    makeServer,
    mountEvidenceClient,
    type EvidenceServer,
} from './evidence-client-harness';

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/evidence');
    for (const k of Array.from(mockSearchParams.keys())) mockSearchParams.delete(k);
    toastError.mockClear();
});

it('a review that lands refetches the retention aggregate the KPI cards read', async () => {
    const row = evidenceRow({ status: 'SUBMITTED' });
    const server: EvidenceServer = makeServer({ rows: [row] });
    installEvidenceFetch(server);
    mountEvidenceClient(server, { role: 'ADMIN', grants: GRANTS.ADMIN, permissions: COARSE.ADMIN });

    const [approve] = await screen.findAllByLabelText(enText('evidence.approveEvidence'));
    await act(async () => {
        fireEvent.click(approve);
    });

    await waitFor(() => {
        const review = server.calls.findIndex((c) => c.method !== 'GET' && c.path === `/evidence/${row.id}/review`);
        expect(review).toBeGreaterThanOrEqual(0);
        const refetched = server.calls.slice(review + 1).some((c) => c.method === 'GET' && c.path === '/evidence/retention');
        expect(refetched).toBe(true);
    });
});
