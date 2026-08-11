/**
 * Epic 58 — reporting integration test.
 *
 * Verifies that the Audit Cycles create form exposes the shared
 * `DateRangePicker` and that submitting the form with a preset
 * applied sends the resolved `periodStartAt` / `periodEndAt`
 * timestamps to the existing API. The backend route has always
 * accepted these optional fields — the UI previously never
 * exposed them, so this integration is a pure additive change to
 * the on-the-wire payload.
 *
 * What's NOT re-tested here:
 *   - The DateRangePicker's own behaviour (covered by
 *     `tests/rendered/date-pickers.test.tsx`).
 *   - The preset catalogue's boundary maths (covered by
 *     `tests/unit/date-picker-foundation.test.ts`).
 *
 * What IS tested:
 *   - The picker renders inside the Audit Cycles form.
 *   - Picking "Year to date" populates the trigger label with that
 *     preset's name — the discoverability contract.
 *   - Submitting the form emits a POST carrying the preset's
 *     resolved `periodStartAt` / `periodEndAt` ISO strings.
 *   - Submitting without a period skips both fields, preserving
 *     backwards compatibility with the previous UI.
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react';

// Route / navigation stubs — the page uses useParams + useRouter.
const routerMock = {
    push: jest.fn(),
};
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme-corp' }),
    useRouter: () => routerMock,
    usePathname: () => '/t/acme-corp/audits/cycles',
}));

// next-intl isn't wired in a bare render; the audit-cycles page
// doesn't depend on it directly, but transitively-imported shared
// components (if any pull it in) need a stub.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key
                .split('.')
                .reduce((o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en[ns]);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});

// Next-auth used transitively by the palette / client boundaries in
// some rendered trees — stub defensively.
jest.mock('next-auth/react', () => ({
    signOut: jest.fn(),
    signIn: jest.fn(),
}));

// The create-cycle trigger is now gated behind <RequirePermission>, whose
// usePermissions() reads a TenantProvider that this bare render doesn't
// mount. This integration test asserts the create-form wiring, not the
// authz gate (that has its own coverage) — render children directly.
jest.mock('@/components/require-permission', () => ({
    RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));


import { SWRConfig } from 'swr';
import AuditCyclesPage from '@/app/t/[tenantSlug]/(app)/audits/cycles/page';

import { DEFAULT_DATE_RANGE_PRESETS } from '@/components/ui/date-picker/presets-catalogue';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

// The page reads through `useTenantSWR` / `useTenantMutation`, which resolve
// `/api/t/{slug}` from the tenant context — so it must be mounted even though
// the authz gate above is stubbed out.
const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme-corp',
    tenantName: 'Acme Corp',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

// ─── Fetch stub ──────────────────────────────────────────────────────

interface FetchCall {
    url: string;
    init?: RequestInit;
}
const fetchCalls: FetchCall[] = [];

function installFetchStub(cycleResponse: { ok: boolean; body?: unknown } = { ok: true, body: { id: 'cyc-1' } }) {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
        async (url: string, init?: RequestInit) => {
            fetchCalls.push({ url, init });
            // The cycles page loads via the readiness-overview orchestrator
            // (cycle list + per-cycle scores in one call). A null/failed body
            // now trips the page's error+retry state, so this must resolve to
            // the joined shape for the form to render.
            if (url.endsWith('/audits/readiness/overview')) {
                return {
                    ok: true,
                    json: async () => ({ cycles: [] as unknown[], scoresByCycleId: {} }),
                };
            }
            if (url.endsWith('/audits/cycles') && (!init || init.method === undefined || init.method === 'GET')) {
                return {
                    ok: true,
                    json: async () => [] as unknown[],
                };
            }
            if (url.endsWith('/audits/cycles') && init?.method === 'POST') {
                return {
                    ok: cycleResponse.ok,
                    json: async () => cycleResponse.body,
                };
            }
            return { ok: true, json: async () => null };
        },
    );
}

beforeEach(() => {
    fetchCalls.length = 0;
    routerMock.push.mockReset();
    installFetchStub();
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

async function mountAndOpenForm() {
    // The cycles page now renders the readiness-legend <Tooltip> (PR-1b),
    // which requires a TooltipProvider — the real app supplies one at the
    // layout level; the test harness must too.
    const utils = render(
        // A fresh SWR cache per test — the cache is module-global, so without
        // a per-test provider one test's populated overview would satisfy the
        // next test's read and mask a broken fetch.
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <TooltipProvider>
                    <AuditCyclesPage />
                </TooltipProvider>
            </TenantProvider>
        </SWRConfig>,
    );
    // Wait for the initial cycles fetch to resolve → component exits the loading state.
    await waitFor(() => {
        expect(utils.container.querySelector('#create-cycle-btn')).not.toBeNull();
    });
    const openBtn = utils.container.querySelector('#create-cycle-btn') as HTMLButtonElement;
    act(() => {
        fireEvent.click(openBtn);
    });
    // The form now lives inside a <Modal> (Radix Dialog.Portal) → it renders at
    // document.body, outside `container`. All form-content queries below use
    // `document` for that reason; only the page-level trigger is in `container`.
    await waitFor(() => {
        expect(document.querySelector('#cycle-form')).not.toBeNull();
    });
    return utils;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('Audit Cycles — DateRangePicker integration', () => {
    it('mounts a DateRangePicker labelled "Audit period" inside the create form', async () => {
        const { getByText } = await mountAndOpenForm();
        expect(getByText('Audit period')).toBeInTheDocument();

        // The picker exposes the canonical trigger marker the shared
        // primitives emit — so any future refactor of the trigger
        // visual can't silently remove the integration.
        const triggers = document.querySelectorAll('[data-date-picker-trigger]');
        expect(triggers.length).toBeGreaterThanOrEqual(1);
    });

    it('offers the curated audit-period preset subset', async () => {
        await mountAndOpenForm();
        // Open the picker popover.
        const trigger = document.querySelector(
            '#cycle-form [data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });

        // The curated list is exactly the slice we selected — we
        // deliberately exclude day-level presets (Today, Yesterday)
        // from audit contexts.
        const expected = [
            'quarter-to-date',
            'year-to-date',
            'last-quarter',
            'last-year',
            'last-90-days',
            'last-30-days',
        ];
        for (const id of expected) {
            expect(
                document.querySelector(`[data-testid="date-picker-preset-${id}"]`),
            ).not.toBeNull();
        }
        // Non-audit presets must NOT appear — would be a regression
        // in the curated subset.
        expect(
            document.querySelector('[data-testid="date-picker-preset-today"]'),
        ).toBeNull();
        expect(
            document.querySelector('[data-testid="date-picker-preset-yesterday"]'),
        ).toBeNull();
    });

    it('shows the preset label on the trigger after selection', async () => {
        await mountAndOpenForm();
        const trigger = document.querySelector(
            '#cycle-form [data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });
        const ytdRow = document.querySelector(
            '[data-testid="date-picker-preset-year-to-date"]',
        ) as HTMLElement;
        act(() => {
            fireEvent.click(ytdRow);
        });
        const updatedTrigger = document.querySelector(
            '#cycle-form [data-date-picker-trigger]',
        ) as HTMLButtonElement;
        const valueNode = updatedTrigger.querySelector(
            '[data-testid="date-picker-trigger-value"]',
        );
        expect(valueNode?.textContent).toBe('Year to date');
    });

    it('includes periodStartAt + periodEndAt in the create POST once a preset is applied', async () => {
        await mountAndOpenForm();
        // Type a name (required).
        const nameInput = document.querySelector(
            '#cycle-name-input',
        ) as HTMLInputElement;
        fireEvent.change(nameInput, {
            target: { value: 'ISO27001 Q2 2026' },
        });

        // Open the picker + pick "Last quarter".
        const trigger = document.querySelector(
            '#cycle-form [data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });
        const lastQuarterRow = document.querySelector(
            '[data-testid="date-picker-preset-last-quarter"]',
        ) as HTMLElement;
        act(() => {
            fireEvent.click(lastQuarterRow);
        });

        // Submit.
        const form = document.querySelector('#cycle-form') as HTMLFormElement;
        await act(async () => {
            fireEvent.submit(form);
        });

        const postCall = fetchCalls.find(
            (c) =>
                c.url.endsWith('/audits/cycles') &&
                c.init?.method === 'POST',
        );
        expect(postCall).toBeDefined();
        const payload = JSON.parse(String(postCall!.init!.body)) as Record<
            string,
            unknown
        >;
        expect(payload.name).toBe('ISO27001 Q2 2026');
        expect(payload.frameworkKey).toBe('ISO27001');
        expect(typeof payload.periodStartAt).toBe('string');
        expect(typeof payload.periodEndAt).toBe('string');

        // Period boundaries should match the resolvable preset, modulo
        // the UTC-midnight origin vs. ISO time-of-day.
        const preset = DEFAULT_DATE_RANGE_PRESETS.find(
            (p) => p.id === 'last-quarter',
        )!;
        const expected = preset.resolve(new Date());
        // We only assert year+month+day because `period.to/from` come
        // from `resolve(new Date())` called inside the component — the
        // reference `now` here is the same wall-clock second, so the
        // quarter it picks must match.
        const actualStart = new Date(String(payload.periodStartAt));
        const actualEnd = new Date(String(payload.periodEndAt));
        expect(actualStart.getUTCFullYear()).toBe(expected.from!.getUTCFullYear());
        expect(actualStart.getUTCMonth()).toBe(expected.from!.getUTCMonth());
        expect(actualStart.getUTCDate()).toBe(expected.from!.getUTCDate());
        expect(actualEnd.getUTCFullYear()).toBe(expected.to!.getUTCFullYear());
        expect(actualEnd.getUTCMonth()).toBe(expected.to!.getUTCMonth());
        expect(actualEnd.getUTCDate()).toBe(expected.to!.getUTCDate());

        // Post-create navigation mirrors the pre-Epic-58 behaviour. The push
        // now happens after the mutation's cache write settles, so wait for
        // it rather than assuming a single flush was enough.
        await waitFor(() =>
            expect(routerMock.push).toHaveBeenCalledWith(
                '/t/acme-corp/audits/cycles/cyc-1',
            ),
        );
    });

    it('omits periodStartAt + periodEndAt when the user skips the picker', async () => {
        await mountAndOpenForm();
        const nameInput = document.querySelector(
            '#cycle-name-input',
        ) as HTMLInputElement;
        fireEvent.change(nameInput, {
            target: { value: 'Cycle without a period' },
        });
        const form = document.querySelector('#cycle-form') as HTMLFormElement;
        await act(async () => {
            fireEvent.submit(form);
        });

        const postCall = fetchCalls.find(
            (c) =>
                c.url.endsWith('/audits/cycles') &&
                c.init?.method === 'POST',
        );
        expect(postCall).toBeDefined();
        const payload = JSON.parse(String(postCall!.init!.body)) as Record<
            string,
            unknown
        >;
        expect(payload.name).toBe('Cycle without a period');
        expect('periodStartAt' in payload).toBe(false);
        expect('periodEndAt' in payload).toBe(false);
    });
});
