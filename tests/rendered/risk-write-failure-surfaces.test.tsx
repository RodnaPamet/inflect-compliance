/**
 * B2-1 — a failed write must be VISIBLE and must not destroy the input.
 *
 * Eight writes across four Risks pages used to `await fetch(...)` with no
 * `res.ok` check, then clear their draft state in a `finally` (or
 * unconditionally). The user saw the form reset — the universal signal for
 * "saved" — while nothing had been written.
 *
 * These are behavioural, not structural, on purpose. A guard that greps for
 * `res.ok` in the page source passes the moment someone writes the check and
 * drops the result on the floor; it also passes while the draft is still
 * being wiped in a `finally`. The only thing that actually distinguishes the
 * fixed page from the broken one is what the DOM holds after a failing click:
 *
 *   1. an error is on screen, and
 *   2. what the user typed is still there.
 *
 * Both pages are mounted for real against a `fetch` that 500s on the write.
 * Chrome that needs shell context (breadcrumbs, back affordance) is stubbed —
 * it is not what is under test.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { SWRConfig } from 'swr';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    // kri and hierarchy gate their write controls on `permissions.canWrite`
    // (every write behind them asserts canWrite server-side). These tests are
    // about what happens when an ALLOWED write fails, so the context is a
    // writer; the gate is covered in risk-write-permission-gates.
    useTenantContext: () => ({
        tenantName: 'Acme', tenantSlug: 'acme', currencySymbol: '€',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
    }),
    useMoneyFormatter: () => (v: number | null | undefined) => String(v ?? ''),
}));

// next-intl is ESM — resolve real en.json values so the assertions below
// match the copy a user would actually read, not a key echo.
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
    usePathname: () => '/t/acme/risks/kri',
    useSearchParams: () => new URLSearchParams(),
}));

// Page chrome that needs the app shell's contexts. Not under test.
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import KriPage from '@/app/t/[tenantSlug]/(app)/risks/kri/page';
import HierarchyPage from '@/app/t/[tenantSlug]/(app)/risks/hierarchy/page';

const en = require('../../messages/en.json');

/**
 * GETs resolve empty; every write 500s. `writeCalls` records the writes so a
 * test can prove the click reached the network — otherwise "the draft
 * survived" would also pass on a page whose button does nothing at all.
 */
const writeCalls: string[] = [];
function installFetch(readBody: Record<string, unknown>) {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
            return {
                ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
                json: async () => readBody, text: async () => JSON.stringify(readBody),
            } as unknown as Response;
        }
        writeCalls.push(`${method} ${String(input)}`);
        const body = { error: { code: 'internal', message: 'boom', requestId: 'req_1' } };
        return {
            ok: false, status: 500, headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body, text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

// SWR's cache is module-global; a fresh provider per render keeps test N from
// reading test N-1's response.
const wrap = (ui: React.ReactElement) =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>{ui}</TooltipProvider>
        </SWRConfig>,
    );

beforeEach(() => {
    writeCalls.length = 0;
    jest.clearAllMocks();
});

describe('KRI page — a failed create keeps the draft and says so', () => {
    beforeEach(() => installFetch({ kris: [] }));

    it('shows the save error and does NOT clear the name the user typed', async () => {
        wrap(<KriPage />);

        const name = await screen.findByPlaceholderText(en.risks.kri.namePlaceholder);
        fireEvent.change(name, { target: { value: 'Phishing click-through rate' } });

        const create = screen.getByRole('button', { name: en.risks.kri.create });
        await waitFor(() => expect(create).toBeEnabled());
        fireEvent.click(create);

        // The failure is on screen...
        const err = await screen.findByTestId('kri-save-error');
        expect(err).toHaveAttribute('role', 'alert');
        expect(err).toHaveTextContent(en.risks.kri.saveError);

        // ...the write really was attempted...
        expect(writeCalls.some((c) => c.startsWith('POST') && c.includes('/risks/kri'))).toBe(true);

        // ...and the draft survived. This is the assertion that fails if the
        // `setDraft(EMPTY_DRAFT)` ever moves back into a `finally`.
        expect(screen.getByPlaceholderText(en.risks.kri.namePlaceholder)).toHaveValue(
            'Phishing click-through rate',
        );
    });

    it('leaves the create button usable after the failure (busy is released)', async () => {
        wrap(<KriPage />);
        const name = await screen.findByPlaceholderText(en.risks.kri.namePlaceholder);
        fireEvent.change(name, { target: { value: 'MFA coverage' } });
        const create = screen.getByRole('button', { name: en.risks.kri.create });
        fireEvent.click(create);
        await screen.findByTestId('kri-save-error');
        await waitFor(() => expect(create).toBeEnabled());
    });
});

describe('Hierarchy page — a failed node add keeps the name and says so', () => {
    beforeEach(() => installFetch({ treemap: [], risks: [], nodes: [] }));

    it('shows the node error and does NOT clear the typed node name', async () => {
        wrap(<HierarchyPage />);

        const input = await screen.findByPlaceholderText(en.risks.hierarchy.newNodePlaceholder);
        fireEvent.change(input, { target: { value: 'Third-party concentration' } });

        const add = screen.getByRole('button', { name: en.risks.hierarchy.addNode });
        await waitFor(() => expect(add).toBeEnabled());
        fireEvent.click(add);

        const err = await screen.findByTestId('hierarchy-node-error');
        expect(err).toHaveAttribute('role', 'alert');
        expect(writeCalls.some((c) => c.startsWith('POST'))).toBe(true);
        expect(screen.getByPlaceholderText(en.risks.hierarchy.newNodePlaceholder)).toHaveValue(
            'Third-party concentration',
        );
    });
});
