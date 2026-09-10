/**
 * The break-glass flag's operator surface.
 *
 * `disableAccount` has refused a protected account since #2036, with the refusal
 * and its reason tested — and nothing ever SET the flag, so the rail was a guard
 * bound to nothing. These tests cover the half that was missing, at the layer an
 * operator actually touches.
 *
 * The load-bearing assertions:
 *   1. Protecting REQUIRES a reason — the submit stays disabled without one, and
 *      the usecase refuses too, so the rule is not only a UI courtesy.
 *   2. Releasing does NOT require one, and opens no modal — but it is no longer
 *      unguarded (#2297). It goes through the house undo-toast pattern, so the
 *      PATCH is DEFERRED behind the undo window: nothing is written on the
 *      click, exactly one PATCH lands once the window closes, and Undo inside
 *      the window means the PATCH never fires at all. That last part is what
 *      makes Undo honest rather than cosmetic — the usecase NULLs
 *      protectedAt / protectedByUserId / protectionReason and writes a
 *      hash-chained audit row, none of which a re-protect would put back.
 *   3. The PATCH goes to the sibling path, not to a route nested under
 *      admin/integrations — nesting would resolve to a weaker permission.
 *   4. A FAILED release is visible. The `saveError` notice is rendered inside
 *      Modal.Body, which never mounts on the release path, so a 403 (the one an
 *      ADMIN gets on this very page) used to be completely silent while the
 *      account stayed protected.
 */
import * as React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

// ─── sonner shim ────────────────────────────────────────────────────
// `useToastWithUndo` calls `toast.custom((t) => <UndoToast … />)` synchronously
// from the trigger. Capture the factory so Undo can be driven from the test by
// invoking the `onUndo` prop the hook wired onto the element — the same shape
// `traceability-panel-undo.test.tsx` uses. The real hook is imported as-is, so
// the delayed commit under test here is the production one.

interface CustomCall {
    id: number;
    factory: (id: number) => React.ReactElement;
}
const customCalls: CustomCall[] = [];
const dismissedIds: Array<string | number> = [];
let nextSonnerId = 1;

jest.mock('sonner', () => ({
    toast: {
        custom: (factory: (id: number) => React.ReactElement) => {
            const id = nextSonnerId++;
            customCalls.push({ id, factory });
            return id;
        },
        dismiss: (id: string | number) => {
            dismissedIds.push(id);
            return id;
        },
        success: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
    },
}));

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/integrations/identity-accounts',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = en[ns] || {};
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
        const t = (key: string) => {
            const v = resolve(key);
            return typeof v === 'string' ? v : key;
        };
        t.rich = t;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// The two builders are hoisted out of the hooks ON PURPOSE. The real hooks
// return `useCallback`-stable references (tenant-context-provider.tsx:74-91),
// and the page's `load` is a `useCallback` keyed on `apiUrl` whose effect
// re-runs whenever that identity changes. Returning a fresh arrow per render
// therefore made the roster refetch on EVERY render and overwrite its own
// optimistic state a tick later — which is exactly the update this file now
// asserts on, so the mock has to be as stable as the thing it stands in for.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

import IdentityAccountsPage from '@/app/t/[tenantSlug]/(app)/admin/integrations/identity-accounts/page';
import { __resetPendingUndoToastsForTest } from '@/components/ui/hooks/use-toast-with-undo';

const account = (over: Record<string, unknown> = {}) => ({
    id: 'acct-1',
    provider: 'entra-id',
    email: 'ada@acme.test',
    displayName: 'Ada L',
    status: 'ACTIVE',
    isAdmin: false,
    mfaEnrolled: true,
    lastActiveAt: null,
    syncedAt: null,
    isProtected: false,
    protectionReason: null,
    ...over,
});

type Row = Record<string, unknown>;

function mockFetch(rows: Row[], opts: { patchOk?: boolean } = {}) {
    const patchOk = opts.patchOk ?? true;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    // The roster refetches after a successful write, so the mock has to behave
    // like the server and carry the change — otherwise a post-commit reload
    // would resurrect the pre-write row and hide a real regression.
    let current = rows;
    const fn = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (init?.method === 'PATCH') {
            if (!patchOk) {
                return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) } as Response;
            }
            const body = JSON.parse(String(init.body)) as { isProtected: boolean; reason: string | null };
            const id = url.split('/').pop();
            current = current.map((r) =>
                (r as { id: string }).id === id
                    ? { ...r, isProtected: body.isProtected, protectionReason: body.reason }
                    : r,
            );
            return { ok: true, json: async () => ({ protection: {} }) } as Response;
        }
        return { ok: true, json: async () => ({ accounts: current }) } as Response;
    });
    global.fetch = fn as unknown as typeof fetch;
    return calls;
}

const patchesIn = (calls: Array<{ url: string; init?: RequestInit }>) =>
    calls.filter((c) => c.init?.method === 'PATCH');

/**
 * Drive Undo by reading `onUndo` + `pendingId` off the captured element. The
 * UndoToast's own UI (countdown, ARIA, keyboard) has its dedicated test in
 * `undo-toast.test.tsx`; this file's scope ends at "does the roster's release
 * handler wire the deferral correctly".
 */
function clickUndo(): void {
    const last = customCalls[customCalls.length - 1];
    if (!last) throw new Error('no undo toast was triggered');
    const props = (last.factory(last.id) as unknown as {
        props: { onUndo: (id: string) => void; pendingId: string };
    }).props;
    props.onUndo(props.pendingId);
}

beforeEach(() => {
    customCalls.length = 0;
    dismissedIds.length = 0;
    nextSonnerId = 1;
    __resetPendingUndoToastsForTest();
});

describe('the never-offboard flag on the identity roster', () => {
    it('offers Protect on an unprotected account and does not submit without a reason', async () => {
        mockFetch([account()]);
        render(<IdentityAccountsPage />);

        const protectBtn = await screen.findByRole('button', { name: 'Protect' });
        fireEvent.click(protectBtn);

        // The modal opened rather than firing a write straight away.
        expect(await screen.findByText(/Why must this account never be offboarded/i)).toBeInTheDocument();

        // Submit is disabled with an empty reason. The usecase refuses too — the
        // UI is the courtesy, not the rule.
        const submit = screen.getAllByRole('button', { name: 'Protect' }).at(-1)!;
        expect(submit).toBeDisabled();
    });

    it('PATCHes the SIBLING path once a reason is given', async () => {
        const calls = mockFetch([account()]);
        render(<IdentityAccountsPage />);

        fireEvent.click(await screen.findByRole('button', { name: 'Protect' }));
        fireEvent.change(await screen.findByLabelText(/Reason/), {
            target: { value: 'break-glass admin' },
        });
        fireEvent.click(screen.getAllByRole('button', { name: 'Protect' }).at(-1)!);

        await waitFor(() => expect(patchesIn(calls).length).toBe(1));
        const patch = patchesIn(calls)[0];
        // The sibling path. Nested under admin/integrations it would match the
        // admin.manage rule instead of admin.tenant_lifecycle.
        expect(patch.url).toBe('/api/t/acme/admin/identity-account-protection/acct-1');
        expect(JSON.parse(String(patch.init?.body))).toEqual({ isProtected: true, reason: 'break-glass admin' });
        // Protecting is the SAFE direction, so it commits immediately — no undo
        // toast is involved on this path.
        expect(customCalls).toHaveLength(0);
    });

    it('releases WITHOUT a reason prompt, and defers the PATCH behind the undo window', async () => {
        const calls = mockFetch([account({ isProtected: true, protectionReason: 'break-glass admin' })]);
        render(<IdentityAccountsPage />);

        const release = await screen.findByRole('button', { name: 'Release' });

        jest.useFakeTimers();
        try {
            fireEvent.click(release);
            await act(async () => {
                await jest.advanceTimersByTimeAsync(0);
            });

            // Nothing has been written yet — the whole point of the deferral.
            expect(patchesIn(calls)).toHaveLength(0);
            expect(customCalls).toHaveLength(1);
            // Releasing still needs no justification: no reason prompt is shown.
            expect(screen.queryByText(/Why must this account never be offboarded/i)).not.toBeInTheDocument();
            // …and the row reads released immediately. The toast is the pending
            // indicator; there is no row-level spinner.
            expect(screen.getByRole('button', { name: 'Protect' })).toBeInTheDocument();
            expect(screen.queryByText('Protected')).not.toBeInTheDocument();

            await act(async () => {
                await jest.advanceTimersByTimeAsync(4999);
            });
            expect(patchesIn(calls)).toHaveLength(0);

            await act(async () => {
                await jest.advanceTimersByTimeAsync(2);
            });

            const patches = patchesIn(calls);
            expect(patches).toHaveLength(1);
            expect(patches[0].url).toBe('/api/t/acme/admin/identity-account-protection/acct-1');
            expect(JSON.parse(String(patches[0].init?.body))).toEqual({ isProtected: false, reason: null });
        } finally {
            jest.useRealTimers();
        }
    });

    it('Undo inside the window means the PATCH never fires at all', async () => {
        const calls = mockFetch([account({ isProtected: true, protectionReason: 'break-glass admin' })]);
        render(<IdentityAccountsPage />);

        const release = await screen.findByRole('button', { name: 'Release' });

        jest.useFakeTimers();
        try {
            fireEvent.click(release);
            await act(async () => {
                await jest.advanceTimersByTimeAsync(0);
            });
            expect(screen.queryByText('Protected')).not.toBeInTheDocument();

            await act(async () => {
                await jest.advanceTimersByTimeAsync(2000);
                clickUndo();
                await jest.advanceTimersByTimeAsync(0);
            });

            // The row reads Protected again…
            expect(screen.getByText('Protected')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Release' })).toBeInTheDocument();

            // …and driving past the original deadline writes NOTHING. No PATCH
            // means the three protection columns are never NULLed and no
            // hash-chained audit row is appended — which is what takes this out
            // of the "not truly reversible" exclusion in
            // docs/destructive-actions.md.
            await act(async () => {
                await jest.advanceTimersByTimeAsync(10_000);
            });
            expect(patchesIn(calls)).toHaveLength(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('a failed release restores the row AND says so, outside any modal', async () => {
        const calls = mockFetch(
            [account({ isProtected: true, protectionReason: 'break-glass admin' })],
            { patchOk: false },
        );
        render(<IdentityAccountsPage />);

        const release = await screen.findByRole('button', { name: 'Release' });

        jest.useFakeTimers();
        try {
            fireEvent.click(release);
            await act(async () => {
                await jest.advanceTimersByTimeAsync(5001);
            });
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(patchesIn(calls)).toHaveLength(1);

            // The account is still protected — the optimistic release rolls back.
            expect(screen.getByText('Protected')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Release' })).toBeInTheDocument();

            // And the operator is TOLD. The pre-existing `saveError` notice lives
            // inside Modal.Body, which never mounts on this path, so before #2297
            // this failure was completely silent.
            expect(screen.getByRole('alert')).toHaveTextContent(/still protected/i);
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        } finally {
            jest.useRealTimers();
        }
    });

    it('shows a protected account as protected', async () => {
        mockFetch([account({ isProtected: true, protectionReason: 'shared ops mailbox' })]);
        render(<IdentityAccountsPage />);

        expect(await screen.findByText('Protected')).toBeInTheDocument();
        // Plain text, not a StatusBadge: this page sits at the badge-density cap,
        // and an unclickable badge beside a button reads as two controls.
        expect(screen.getByText('Protected').tagName).toBe('SPAN');
    });
});
