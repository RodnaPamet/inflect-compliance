/**
 * Write controls on the Risks analytics pages must not render for someone
 * the server will refuse.
 *
 * Five of these pages had NO permission gate at all. Every write behind them
 * calls `assertCanWrite` (or, for one, `assertCanAdmin`), so a READER or
 * AUDITOR saw a full editing surface whose every button was a guaranteed 403.
 * Until #1855 those 403s were also silent, which is how it went unnoticed.
 *
 * The gate mirrors the SERVER predicate — `ctx.permissions.canWrite` /
 * `canAdmin` — rather than an `appPermissions` sub-key, so a custom role can
 * never be shown a control the usecase will reject. That is the invariant
 * worth locking, and it is only observable by rendering: the flags are read
 * through a hook, so no import graph or type check can see the mismatch.
 *
 * Each page gets the same pair — absent for a reader, present for a writer.
 * The positive half matters as much as the negative: a gate that hides the
 * control from EVERYONE also passes a "reader sees nothing" assertion.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { SWRConfig } from 'swr';

type Perms = { canRead: boolean; canWrite: boolean; canAdmin: boolean; canAudit: boolean; canExport: boolean };
const READER: Perms = { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false };
const EDITOR: Perms = { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true };
const ADMIN: Perms = { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true };

let perms: Perms = EDITOR;

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        userId: 'u1', tenantId: 't1', tenantSlug: 'acme', tenantName: 'Acme',
        currencySymbol: '€', role: 'EDITOR',
        permissions: perms,
        appPermissions: {},
    }),
    usePermissions: () => ({}),
    useMoneyFormatter: () => (v: number | null | undefined) => String(v ?? ''),
    useCurrentUserId: () => 'u1',
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const resolve = (ns: string, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) for (const [p, val] of Object.entries(params)) s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return s;
        };
        t.rich = (key: string) => resolve(ns, key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), refresh: jest.fn(),
        back: jest.fn(), forward: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/risks',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import KriPage from '@/app/t/[tenantSlug]/(app)/risks/kri/page';
import HierarchyPage from '@/app/t/[tenantSlug]/(app)/risks/hierarchy/page';
import LossEventsPage from '@/app/t/[tenantSlug]/(app)/risks/loss-events/page';
import ScenariosPage from '@/app/t/[tenantSlug]/(app)/risks/scenarios/page';

const en = require('../../messages/en.json');

/**
 * Bodies are routed by path rather than merged into one blob: the loss-events
 * aggregate reads `agg.byYear.length` unguarded, so a body missing that key
 * throws during render and the assertion below would fail for a reason that
 * has nothing to do with permissions.
 */
function bodyFor(url: string): Record<string, unknown> {
    if (url.includes('/loss-events/aggregate')) return { byYear: [], byCategory: [], total: 0, count: 0 };
    if (url.includes('/loss-events')) {
        // One event so the list — and therefore its Remove button — renders.
        return { events: [{ id: 'le1', amount: 1000, occurredAt: '2026-01-01T00:00:00.000Z', description: 'Outage' }] };
    }
    if (url.includes('/risks/kri')) return { kris: [] };
    if (url.includes('/risks/hierarchy')) return { treemap: [] };
    if (url.includes('/risks/scenarios')) return { scenarios: [] };
    if (url.includes('/risks/simulate')) return { run: null };
    if (url.includes('/risks/options')) return { risks: [] };
    return {};
}

beforeEach(() => {
    perms = EDITOR;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const body = bodyFor(String(input));
        return {
            ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body, text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
});

const mount = (ui: React.ReactElement) =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>{ui}</TooltipProvider>
        </SWRConfig>,
    );

describe.each([
    ['KRI', () => <KriPage />, () => en.risks.kri.create],
    ['Hierarchy', () => <HierarchyPage />, () => en.risks.hierarchy.addNode],
    ['Scenarios', () => <ScenariosPage />, () => en.risks.scenarios.create],
])('%s page — the create control follows canWrite', (_label, page, label) => {
    it('is absent for a READER (every write asserts canWrite)', async () => {
        perms = READER;
        mount(page());
        expect(screen.queryByRole('button', { name: label() })).not.toBeInTheDocument();
    });

    it('is present for an EDITOR', async () => {
        perms = EDITOR;
        mount(page());
        expect(await screen.findByRole('button', { name: label() })).toBeInTheDocument();
    });
});

describe('Loss events — the two controls assert DIFFERENT levels', () => {
    // createLossEvent → assertCanWrite. deleteLossEvent → assertCanAdmin.
    // Gating both on one flag would be wrong in both directions: it either
    // hides Record from an EDITOR who may use it, or shows Remove to one who
    // may not.
    it('READER sees neither', async () => {
        perms = READER;
        mount(<LossEventsPage />);
        expect(screen.queryByRole('button', { name: en.risks.lossEvents.record })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: en.risks.lossEvents.remove })).not.toBeInTheDocument();
    });

    it('EDITOR sees Record but NOT Remove — the whole point of the split', async () => {
        perms = EDITOR;
        mount(<LossEventsPage />);
        expect(await screen.findByRole('button', { name: en.risks.lossEvents.record })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: en.risks.lossEvents.remove })).not.toBeInTheDocument();
    });

    it('ADMIN sees both', async () => {
        perms = ADMIN;
        mount(<LossEventsPage />);
        expect(await screen.findByRole('button', { name: en.risks.lossEvents.record })).toBeInTheDocument();
        expect(await screen.findByRole('button', { name: en.risks.lossEvents.remove })).toBeInTheDocument();
    });
});
