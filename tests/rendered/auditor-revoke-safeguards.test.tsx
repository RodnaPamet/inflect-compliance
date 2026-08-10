/** @jest-environment jsdom */

/**
 * Revoking an external auditor's access has to be hard to do by accident.
 *
 * Two revokes live on this page, and they are NOT the same kind of act, so
 * Epic 67 gives them different safeguards:
 *
 *   - **One pack grant** (`revokeAccess`) is routine and reversible — you can
 *     re-grant it. It takes the undo toast: the DELETE is scheduled, not sent,
 *     and Undo cancels it before it ever reaches the server.
 *   - **The whole account** (`revokeAccount`) cascades: it flips the
 *     AuditorAccount to REVOKED and drops every pack grant at once. That is
 *     the documented Epic 67 exception where five seconds is not long enough
 *     to reconsider, so it takes a TYPED confirmation naming the auditor.
 *
 * Both previously sat on the same click-through ConfirmDialog, which is
 * neither of those things: it makes the routine case slower than it needs to
 * be while leaving the cascading case one un-aimed click away.
 *
 * The load-bearing assertion is that Undo means **no DELETE is ever sent** —
 * not "a DELETE is sent and then compensated". Nothing on the server side
 * un-revokes an auditor.
 */

import * as React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

// ─── sonner shim ────────────────────────────────────────────────────
// `useToastWithUndo` calls `toast.custom((id) => <UndoToast …/>)` synchronously
// from the trigger. Capture the factory so the Undo button is reachable.
interface CustomCall { id: number; factory: (id: number) => React.ReactElement }
const customCalls: CustomCall[] = [];
let nextSonnerId = 1;

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign(
        (msg: string) => msg,
        {
            custom: (factory: (id: number) => React.ReactElement) => {
                const id = nextSonnerId++;
                customCalls.push({ id, factory });
                return id;
            },
            dismiss: (id: string | number) => id,
            success: jest.fn(),
            error: jest.fn(),
            warning: jest.fn(),
            info: jest.fn(),
            message: jest.fn(),
            loading: jest.fn(),
        },
    ),
}));

// Radix's tooltip provider spins its own timers; under fake timers it never
// settles and every test in the file times out. The tooltip is not what this
// file is about — pass the trigger through.
jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: () => null,
}));

// The repo-wide `__mocks__/next-intl.js` returns a FRESH `t` function on every
// render. This page's load effect lists `tx` in its deps, so under that mock
// each render re-runs the effect, sets state, and renders again — the suite
// hangs before a single assertion. Real next-intl memoises `t` per namespace,
// so this local mock does the same and the page behaves as it does in the
// browser.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            const str = typeof val === 'string' ? val : key;
            return params
                ? str.replace(/\{(\w+)\}/g, (m, n) =>
                    Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : m)
                : str;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
        useFormatter: () => ({ dateTime: String, number: String, relativeTime: String, list: (l: string[]) => l.join(', ') }),
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), back: jest.fn(),
        refresh: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/audits/auditors',
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { SWRConfig } from 'swr';
import AuditorsPage from '@/app/t/[tenantSlug]/(app)/audits/auditors/page';
import { __resetPendingUndoToastsForTest } from '@/components/ui/hooks/use-toast-with-undo';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

// A real provider rather than a mock: the page gates affordances behind
// `<RequirePermission>`, and a mocked-away permission layer would let a
// broken gate pass this file.
const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

const AUDITOR = {
    id: 'aud-1',
    email: 'external@auditfirm.example',
    name: 'Dana Auditor',
    status: 'ACTIVE',
    createdAt: '2026-07-01T00:00:00.000Z',
    packAccess: [{ auditPackId: 'pack-1' }],
};
const PACKS = [{ id: 'pack-1', name: 'FY26 ISO pack', status: 'FROZEN' }];

const fetchMock = jest.fn();

function jsonOk(body: unknown) {
    return Promise.resolve({ ok: true, json: async () => body } as Response);
}

beforeEach(() => {
    customCalls.length = 0;
    nextSonnerId = 1;
    __resetPendingUndoToastsForTest();
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes('/audits/packs')) return jsonOk(PACKS);
        if (u.includes('/audits/auditors/access')) return jsonOk({});
        if (/\/audits\/auditors\/[^/]+$/.test(u)) return jsonOk({});
        return jsonOk([AUDITOR]);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
    // Only meaningful for the tests that opted into fake timers; harmless
    // otherwise, and it guarantees one test's clock never leaks into the next.
    if (jest.isMockFunction(setTimeout)) jest.runOnlyPendingTimers();
    jest.useRealTimers();
});

/**
 * Run `body` with the undo window under fake timers.
 *
 * THE ORDERING MATTERS. Installing fake timers before the page's first SWR
 * read means that read never settles: SWR's revalidation is scheduled on
 * timers, so the cache entry is never populated, and the first `mutate()`
 * indexes into an undefined internal state — surfacing as
 * `TypeError: Cannot read properties of undefined (reading '6')` from inside
 * SWR rather than as anything recognisable.
 *
 * So: let the data land on real timers, THEN fake the clock for the 5-second
 * window only. Same shape as tests/rendered/traceability-panel-undo.test.tsx,
 * which is the file this recipe comes from.
 */
async function withUndoClock(body: () => Promise<void>): Promise<void> {
    jest.useFakeTimers();
    try {
        await body();
    } finally {
        jest.useRealTimers();
    }
}

/** Render and flush the two load fetches. */
async function renderPage() {
    const view = render(
        // A fresh SWR cache per test. The page reads its auditor list through
        // SWR, whose cache is module-global — without this, one test's
        // optimistic removal is still applied when the next one renders and
        // the row it needs is simply absent.
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <AuditorsPage />
            </TenantProvider>
        </SWRConfig>,
    );
    // Real timers here on purpose — see `withUndoClock`.
    await waitFor(() => expect(document.getElementById('revoke-account-aud-1')).not.toBeNull());
    return view;
}

function byId<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not in the document`);
    return el as T;
}

/** DELETEs actually dispatched so far, by URL substring. */
function deletesTo(fragment: string) {
    return fetchMock.mock.calls.filter(
        ([url, init]) => init?.method === 'DELETE' && String(url).includes(fragment),
    );
}

describe('revoking ONE pack grant — undo toast', () => {
    it('does not send the DELETE while the undo window is open', async () => {
        await renderPage();
        await act(async () => { fireEvent.click(byId('revoke-access-aud-1-pack-1')); });

        expect(customCalls.length).toBeGreaterThan(0); // scheduled…
        expect(deletesTo('/audits/auditors/access')).toHaveLength(0); // …not sent
    });

    it('sends the DELETE once the window elapses', async () => {
        await renderPage();
        await withUndoClock(async () => {
            await act(async () => { fireEvent.click(byId('revoke-access-aud-1-pack-1')); });
            await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
            await waitFor(() => expect(deletesTo('/audits/auditors/access')).toHaveLength(1));
        });
    });

    it('UNDO cancels it — no DELETE is ever sent', async () => {
        // The assertion that matters. Nothing un-revokes an auditor server-side,
        // so "send it, then compensate" is not an acceptable implementation.
        await renderPage();
        await withUndoClock(async () => {
            await act(async () => { fireEvent.click(byId('revoke-access-aud-1-pack-1')); });

            const host = document.createElement('div');
            document.body.appendChild(host);
            const last = customCalls[customCalls.length - 1];
            const undoView = render(last.factory(last.id), { container: host });
            const undo = undoView.getByRole('button', { name: /undo/i });
            await act(async () => { fireEvent.click(undo); });

            await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
            expect(deletesTo('/audits/auditors/access')).toHaveLength(0);
        });
    });

    it('the grant reappears in the list after Undo', async () => {
        // The optimistic removal has to be reversed too — otherwise the row
        // looks revoked while the server still holds the grant.
        await renderPage();
        expect(document.getElementById('revoke-access-aud-1-pack-1')).not.toBeNull();
        await act(async () => { fireEvent.click(byId('revoke-access-aud-1-pack-1')); });
        expect(document.getElementById('revoke-access-aud-1-pack-1')).toBeNull();

        const last = customCalls[customCalls.length - 1];
        const host = document.createElement('div');
        document.body.appendChild(host);
        const undoView = render(last.factory(last.id), { container: host });
        await act(async () => {
            fireEvent.click(undoView.getByRole('button', { name: /undo/i }));
        });

        expect(document.getElementById('revoke-access-aud-1-pack-1')).not.toBeNull();
    });
});

describe('revoking the WHOLE account — typed confirmation', () => {
    async function openAccountRevoke() {
        await renderPage();
        await act(async () => { fireEvent.click(byId('revoke-account-aud-1')); });
    }

    it('opening the dialog sends nothing', async () => {
        await openAccountRevoke();
        expect(byId('revoke-account-confirm-input')).toBeTruthy();
        expect(deletesTo('/audits/auditors/')).toHaveLength(0);
    });

    it('confirm stays disabled until the email is typed EXACTLY', async () => {
        await openAccountRevoke();
        const input = byId<HTMLInputElement>('revoke-account-confirm-input');
        const confirm = byId<HTMLButtonElement>('revoke-account-confirm-submit');

        expect(confirm.disabled).toBe(true);

        // A near-miss must not enable it — the point is naming the target.
        await act(async () => {
            fireEvent.change(input, { target: { value: 'external@auditfirm.exampl' } });
        });
        expect(confirm.disabled).toBe(true);

        await act(async () => {
            fireEvent.change(input, { target: { value: AUDITOR.email } });
        });
        expect(confirm.disabled).toBe(false);
    });

    it('sends the account DELETE once confirmed', async () => {
        await openAccountRevoke();
        await act(async () => {
            fireEvent.change(byId('revoke-account-confirm-input'), {
                target: { value: AUDITOR.email },
            });
        });
        await act(async () => { fireEvent.click(byId('revoke-account-confirm-submit')); });

        await waitFor(() =>
            expect(
                fetchMock.mock.calls.some(
                    ([url, init]) =>
                        init?.method === 'DELETE' && /\/audits\/auditors\/aud-1$/.test(String(url)),
                ),
            ).toBe(true),
        );
    });

    it('the cascading revoke is NOT wired to the undo toast', async () => {
        // Epic 67's documented exception: five seconds is too short to
        // reconsider dropping every grant an external auditor holds. If this
        // ever starts scheduling instead of confirming, the safeguard is gone.
        await openAccountRevoke();
        await act(async () => {
            fireEvent.change(byId('revoke-account-confirm-input'), {
                target: { value: AUDITOR.email },
            });
        });
        await act(async () => { fireEvent.click(byId('revoke-account-confirm-submit')); });

        expect(customCalls).toHaveLength(0);
    });
});
