/**
 * Audits data-access migration — the stale-data guards.
 *
 * The hand-rolled loaders these components replaced fetched exactly ONCE, on
 * mount. `useTenantSWR` also revalidates on focus and on reconnect, and SWR
 * keeps the cached data when a revalidation fails. That combination creates a
 * state the old code could never reach: `error` set while `data` is still good
 * and `isLoading` is false.
 *
 * A faithful line-by-line translation of the old `if (failed) showError` is
 * therefore WRONG after the migration — it tears down a working screen over a
 * transient blip. Each test below drives exactly that sequence:
 *
 *   1. mount, first read succeeds, assert the good state is on screen
 *   2. make the next request fail
 *   3. force a revalidation of that key
 *   4. assert the good state is STILL on screen
 *
 * Step 3 uses an explicit `mutate(key)` rather than a synthetic focus event on
 * purpose: SWR throttles focus revalidation (`focusThrottleInterval`), so a
 * focus-driven test would be timing-dependent. Forcing the revalidation
 * directly reproduces the same cache transition deterministically.
 */

import React from 'react';
import { render, act, waitFor, fireEvent, screen } from '@testing-library/react';

const routerMock = { push: jest.fn(), refresh: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme-corp' }),
    useRouter: () => routerMock,
    usePathname: () => '/t/acme-corp/audits/cycles',
    useSearchParams: () => new URLSearchParams(),
}));

// Memoised per (namespace, key): the page-level trees below re-render often,
// and a mock that returns a FRESH `t` function on every call makes any
// `useMemo([t])` downstream invalidate every render — which loops a rendered
// test into a timeout rather than a failure.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = key
            .split('.')
            .reduce(
                (o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
                (en as Record<string, unknown>)[ns],
            );
        if (typeof v !== 'string') return key;
        if (params) {
            for (const [p, val] of Object.entries(params)) {
                v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            }
        }
        return v as string;
    };
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns)!;
        },
        useLocale: () => 'en',
    };
});

jest.mock('next-auth/react', () => ({ signOut: jest.fn(), signIn: jest.fn() }));

jest.mock('@/components/require-permission', () => ({
    RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The picker opens a Microsoft Graph browser; this suite is about whether the
// TRIGGER survives a failed revalidation, not what the picker renders.
jest.mock('@/components/integrations/sharepoint/SharePointFilePicker', () => ({
    SharePointFilePicker: () => null,
}));

import { SWRConfig, useSWRConfig } from 'swr';
import AuditCyclesPage from '@/app/t/[tenantSlug]/(app)/audits/cycles/page';
import { SharePointExportButton } from '@/app/t/[tenantSlug]/(app)/audits/packs/[packId]/SharePointExportButton';
import { RespondClient } from '@/app/t/[tenantSlug]/(app)/audits/nis2-gap/respond/[assignmentId]/RespondClient';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme-corp',
    tenantName: 'Acme Corp',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

// ─── Harness ────────────────────────────────────────────────────────────

/**
 * Forces a revalidation of one resolved SWR key from inside the provider —
 * the deterministic stand-in for the focus/reconnect revalidation that fires
 * in the real app.
 */
function Revalidate({ swrKey }: { swrKey: string }) {
    const { mutate } = useSWRConfig();
    return (
        <button
            type="button"
            id="force-revalidate"
            // `.catch` is required, not tidiness: when the revalidation fails —
            // which is the entire point of these tests — `mutate` rejects, and
            // an unhandled rejection fails the suite for the wrong reason.
            onClick={() => void mutate(swrKey).catch(() => {})}
        >
            revalidate
        </button>
    );
}

/** Route table for the stubbed `fetch`, swappable mid-test. */
let routes: Record<string, () => { ok: boolean; json: () => Promise<unknown> }> = {};

/**
 * When set, every request 503s regardless of the route table. A flag rather
 * than a doctored route table on purpose: an earlier version of this harness
 * swapped `routes` for a catch-all Proxy, and because the dispatch below is
 * `url.endsWith(suffix)`, the Proxy's single synthetic key never matched — so
 * "broken" requests quietly resolved `{ ok: true, body: null }` and the tests
 * asserted against the wrong failure entirely.
 */
let failAll = false;

function installFetch() {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => {
        if (failAll) {
            return {
                ok: false,
                status: 503,
                json: async () => ({ error: { code: 'UPSTREAM', message: 'upstream down' } }),
            };
        }
        for (const [suffix, handler] of Object.entries(routes)) {
            if (url.endsWith(suffix)) return handler();
        }
        return { ok: true, json: async () => null };
    });
}

/** Every route starts failing — the transient-blip half of each test. */
function breakEverything() {
    failAll = true;
}

function mount(ui: React.ReactNode, swrKey: string) {
    return render(
        // Fresh cache per test: the SWR cache is module-global, so a populated
        // entry would otherwise satisfy the next test's read.
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TenantProvider value={TENANT_CTX}>
                <TooltipProvider>
                    {ui}
                    <Revalidate swrKey={swrKey} />
                </TooltipProvider>
            </TenantProvider>
        </SWRConfig>,
    );
}

async function forceFailedRevalidation(container: HTMLElement) {
    breakEverything();
    await act(async () => {
        fireEvent.click(container.querySelector('#force-revalidate')!);
    });
    // Let the rejected fetch settle into SWR's error state.
    await act(async () => {
        await Promise.resolve();
    });
}

beforeEach(() => {
    routerMock.push.mockReset();
    routes = {};
    failAll = false;
    installFetch();
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

// ─── Cycles page ────────────────────────────────────────────────────────

describe('Audit cycles page — a failed revalidation does not discard the list', () => {
    it('keeps the rendered cycles when a background revalidation fails', async () => {
        routes = {
            '/audits/readiness/overview': () => ({
                ok: true,
                json: async () => ({
                    cycles: [
                        {
                            id: 'cyc-1',
                            name: 'ISO 27001 Surveillance 2026',
                            frameworkKey: 'ISO27001',
                            frameworkVersion: '2022',
                            status: 'PLANNING',
                            createdAt: '2026-01-01T00:00:00.000Z',
                        },
                    ],
                    scoresByCycleId: {},
                }),
            }),
            '/frameworks': () => ({ ok: true, json: async () => [] }),
        };

        const { container } = mount(<AuditCyclesPage />, '/api/t/acme-corp/audits/readiness/overview');

        await waitFor(() =>
            expect(container.textContent).toContain('ISO 27001 Surveillance 2026'),
        );

        await forceFailedRevalidation(container);

        // The regression: `loadError = Boolean(error)` returned the full-page
        // Retry empty state here, discarding a perfectly readable list.
        expect(container.textContent).toContain('ISO 27001 Surveillance 2026');
    });

    it('still shows the error state when the FIRST load fails', async () => {
        breakEverything();
        const { container } = mount(<AuditCyclesPage />, '/api/t/acme-corp/audits/readiness/overview');

        // With no cached data there is nothing readable to protect, so the
        // error branch must still fire — the guard narrows it, it does not
        // remove it. Asserted positively (the error copy is on screen), not as
        // "the list is absent": an absent list is also what a still-loading
        // page looks like, so the negative form would pass on a skeleton.
        await waitFor(
            () => {
                expect(container.textContent).toContain("Couldn't load audit cycles");
            },
            { timeout: 10_000 },
        );
        // And it must NOT be mistaken for a first-run.
        expect(container.textContent).not.toContain('No audit cycles yet');
    });
});

// ─── SharePoint export button ───────────────────────────────────────────

describe('SharePoint export button — a failed probe revalidation does not hide it', () => {
    const KEY = '/api/t/acme-corp/integrations/sharepoint/connections';

    it('keeps the button mounted when a revalidation of the probe fails', async () => {
        routes = {
            '/integrations/sharepoint/connections': () => ({
                ok: true,
                json: async () => [{ id: 'conn-1' }],
            }),
        };

        const { container } = mount(<SharePointExportButton packId="pack-1" />, KEY);

        await waitFor(() => expect(container.querySelector('button')).toBeTruthy());
        const before = container.querySelectorAll('button').length;

        await forceFailedRevalidation(container);

        // The regression: an error-FIRST tri-state flipped `available` to
        // false and unmounted an export control whose connection id was still
        // perfectly valid.
        expect(container.querySelectorAll('button').length).toBe(before);
    });

    it('stays hidden when the probe fails before it ever succeeded', async () => {
        breakEverything();
        const { container } = mount(<SharePointExportButton packId="pack-1" />, KEY);

        // Cold start with no destination: offering the trigger would only open
        // a picker that cannot resolve a drive.
        await waitFor(
            () => {
                const buttons = Array.from(container.querySelectorAll('button'));
                expect(buttons.filter((b) => b.id !== 'force-revalidate')).toHaveLength(0);
            },
            { timeout: 10_000 },
        );
    });
});

// ─── Respondent form ────────────────────────────────────────────────────

describe('NIS2 respond form — a revalidation does not clobber in-progress answers', () => {
    const KEY = '/api/t/acme-corp/gap-assignments/asg-1';

    const payload = {
        assignment: {
            id: 'asg-1',
            assessmentId: 'asm-1',
            respondentRole: 'IT_SECURITY',
            status: 'PENDING',
            questionIds: ['q1'],
        },
        questions: [
            {
                id: 'q1',
                domainId: 1,
                plainText: { en: 'Is MFA enforced for all admins?', de: 'MFA?' },
                legalBasis: 'Art. 21(2)(j)',
                criticality: 'HIGH',
            },
        ],
        domains: [{ id: 1, code: 'D1', name: { en: 'Access control', de: 'Zugriff' } }],
        // The server has NOT recorded an answer yet.
        answers: [] as Array<{ questionId: string; answer: string }>,
    };

    it('preserves an unsaved answer across a revalidation that returns the old payload', async () => {
        routes = { '/gap-assignments/asg-1': () => ({ ok: true, json: async () => payload }) };

        const { container } = mount(
            <RespondClient tenantSlug="acme-corp" assignmentId="asg-1" />,
            KEY,
        );

        await waitFor(() =>
            expect(container.textContent).toContain('Is MFA enforced for all admins?'),
        );

        // The respondent picks an answer but has not submitted.
        const yes = screen.getAllByRole('radio')[0] as HTMLElement;
        await act(async () => {
            fireEvent.click(yes);
        });
        await waitFor(() => expect(yes.getAttribute('aria-checked')).toBe('true'));

        // A revalidation lands, returning the payload WITHOUT their answer —
        // exactly what a focus revalidation does before they submit.
        await act(async () => {
            fireEvent.click(container.querySelector('#force-revalidate')!);
        });
        await act(async () => {
            await Promise.resolve();
        });

        // Seeding `answers` from the payload in an effect would wipe this.
        // The saved+edits merge is what keeps it.
        expect(yes.getAttribute('aria-checked')).toBe('true');
    });
});
