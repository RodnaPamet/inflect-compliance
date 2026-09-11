/**
 * The two ways the synced-identity roster could lie about what it is showing.
 *
 * This page is where an operator decides which accounts must NEVER be
 * offboarded automatically, so "the list is complete and each line is one
 * account" is not a display detail — it is the premise the decision rests on.
 * Both halves of that premise were unstated (#2297 items 4 and 5):
 *
 *   1. THE CAP IS SILENT. `listConnectedAccounts` takes
 *      IDENTITY_ROSTER_PAGE_SIZE rows — a hard cap, not a cursor page, with no
 *      `truncated` flag on the wire and no search on this page. A directory
 *      with more accounts than the cap rendered a subset that looked exactly
 *      like the whole thing, and an account past it cannot be protected from
 *      here. The truncation idiom already existed in the codebase
 *      (`AccessReviewsClient` compares row count against the same constant and
 *      stands its gate down); it had simply never been applied to the one page
 *      whose job is this decision.
 *
 *   2. TWO ROWS FOR ONE HUMAN WERE INDISTINGUISHABLE. Two connections for one
 *      provider is a supported configuration and the account key is
 *      (tenantId, connectionId, externalUserId), so one person can hold two
 *      rows agreeing on provider, email and display name. `isProtected` is per
 *      ROW, so protecting the visible one leaves the other unprotected.
 *
 * WHAT THIS FILE DOES NOT CLAIM. The connection column is a LEGIBILITY fix, not
 * a rail: with two enabled connections for one provider the leaver pass refuses
 * WRITER_AMBIGUOUS_CONNECTION before any write (identity-writer-factory.ts) —
 * see `tests/unit/identity-leaver-*` for that behaviour. This is about the
 * operator being able to see what they are protecting.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('sonner', () => ({
    toast: { custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/integrations/identity-accounts',
    useSearchParams: () => new URLSearchParams(),
}));

// The real catalog, and — unlike the sibling protection test's mock — one that
// INTERPOLATES. The truncation title carries `{cap}` from the shared constant,
// so a mock that ignored values would assert against a placeholder instead of
// the number the operator reads.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = en[ns] || {};
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
            if (typeof v !== 'string') return key;
            return values
                ? v.replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name]) : m))
                : v;
        };
        t.rich = t;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

import IdentityAccountsPage from '@/app/t/[tenantSlug]/(app)/admin/integrations/identity-accounts/page';
import { IDENTITY_ROSTER_PAGE_SIZE } from '@/lib/identity-roster';

type Row = Record<string, unknown>;

const account = (over: Row = {}): Row => ({
    id: 'acct-1',
    provider: 'entra-id',
    connectionId: 'conn-1',
    connectionName: 'Corp Entra',
    email: 'ada@acme.test',
    displayName: 'Ada L',
    status: 'ACTIVE',
    isAdmin: false,
    mfaEnrolled: true,
    lastActiveAt: null,
    syncedAt: null,
    isProtected: false,
    protectionReason: null,
    linked: true,
    unlinkedReason: null,
    ...over,
});

function mockFetch(rows: Row[]) {
    global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ accounts: rows }),
    })) as unknown as typeof fetch;
}

const fill = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => account({ id: `acct-${i}`, email: `user${i}@acme.test` }));

describe('the cap says so', () => {
    it('says nothing when the roster came back SHORT of the cap', async () => {
        mockFetch(fill(3));
        render(<IdentityAccountsPage />);

        expect(await screen.findByText('user0@acme.test')).toBeInTheDocument();
        expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
    });

    it('warns when the roster came back AT the cap, naming the number', async () => {
        // A full page is the only evidence available: the response carries no
        // `truncated` flag (deliberately — the access-review page reads this
        // body through a reader that fails open on an unrecognised shape), so
        // "length === cap" is the same signal the access-reviews directory
        // gate already stands down on.
        mockFetch(fill(IDENTITY_ROSTER_PAGE_SIZE));
        render(<IdentityAccountsPage />);

        const notice = await screen.findByText(
            `Showing the first ${IDENTITY_ROSTER_PAGE_SIZE} accounts`,
        );
        expect(notice).toBeInTheDocument();
        // And it says what the cap MEANS, not just that it fired: absence from
        // this page is not evidence the account is absent.
        expect(
            screen.getByText(/absence from this page is not evidence that an account is absent/i),
        ).toBeInTheDocument();
        // No dismiss control. InlineNotice renders its X only when handed an
        // onDismiss, and this is a standing property of what is on screen
        // rather than an event to acknowledge. Asserted HERE rather than in its
        // own case so the cap-sized render happens once: a full roster is 500
        // rows through the real DataTable, which is the slowest thing in this
        // file by an order of magnitude.
        expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
    });
});

describe('two rows for one human are told apart', () => {
    it('shows the connection when one provider has more than one', async () => {
        // The shape the finding names: same provider, same email, same display
        // name, different connection — and only one of them protected.
        mockFetch([
            account({ id: 'a-eu', connectionId: 'conn-eu', connectionName: 'EU forest', isProtected: true, protectionReason: 'break-glass' }),
            account({ id: 'a-us', connectionId: 'conn-us', connectionName: 'US forest' }),
        ]);
        render(<IdentityAccountsPage />);

        expect(await screen.findByRole('columnheader', { name: 'Connection' })).toBeInTheDocument();
        expect(screen.getByText('EU forest')).toBeInTheDocument();
        expect(screen.getByText('US forest')).toBeInTheDocument();
        // The asymmetry the operator has to be able to see: one row protected,
        // one not, and now something on the line says which is which.
        expect(screen.getByRole('button', { name: 'Release' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Protect' })).toBeInTheDocument();
    });

    it('stays out of the way when every provider has exactly one', async () => {
        // The normal configuration, including the one tenant running this
        // today. A column repeating one name down every row is noise.
        mockFetch([
            account({ id: 'a', connectionId: 'conn-1', connectionName: 'Corp Entra' }),
            account({ id: 'b', provider: 'okta', connectionId: 'conn-2', connectionName: 'Corp Okta', email: 'bob@acme.test' }),
        ]);
        render(<IdentityAccountsPage />);

        await screen.findByText('ada@acme.test');
        await waitFor(() =>
            expect(screen.queryByRole('columnheader', { name: 'Connection' })).not.toBeInTheDocument(),
        );
        // Two providers, one connection each — the provider badge already
        // tells those two rows apart.
        expect(screen.queryByText('Corp Entra')).not.toBeInTheDocument();
    });

    it('falls back to the id rather than an empty cell if the name is missing', async () => {
        mockFetch([
            account({ id: 'a-eu', connectionId: 'conn-eu', connectionName: null }),
            account({ id: 'a-us', connectionId: 'conn-us', connectionName: 'US forest' }),
        ]);
        render(<IdentityAccountsPage />);

        expect(await screen.findByText('conn-eu')).toBeInTheDocument();
    });
});


describe('the cap is a page size, not a reachability limit', () => {
    /** Every roster URL this render has asked for, in order. */
    const rosterCalls = (): string[] =>
        (global.fetch as jest.Mock).mock.calls
            .map((c) => String(c[0]))
            .filter((u) => u.includes('/admin/integrations/identity-accounts'));

    /** A fetch whose answer depends on the query string, like the real route. */
    function mockSearchableFetch(byQuery: (url: string) => Row[]) {
        global.fetch = jest.fn(async (url: string) => ({
            ok: true,
            json: async () => ({ accounts: byQuery(String(url)) }),
        })) as unknown as typeof fetch;
    }

    /** Open the Filter popover and return its live content-search input. */
    async function openSearch(): Promise<HTMLInputElement> {
        const trigger = document.querySelector('[data-filter-trigger]') as HTMLElement;
        expect(trigger).not.toBeNull();
        fireEvent.click(trigger);
        await waitFor(() => {
            expect(document.querySelector('#identity-accounts-search input')).not.toBeNull();
        });
        return document.querySelector('#identity-accounts-search input') as HTMLInputElement;
    }

    it('asks for the WHOLE roster on first load, with no query string', async () => {
        // Not decoration. The access-reviews directory gate reads this same
        // route unfiltered and infers "nothing synced" from a short page; a
        // default filter here would be a different list wearing the same name.
        mockFetch(fill(2));
        render(<IdentityAccountsPage />);

        await screen.findByText('user0@acme.test');
        expect(rosterCalls()[0]).toBe('/api/t/acme/admin/integrations/identity-accounts');
    });

    it('sends the typed term to the SERVER rather than filtering the page it already has', async () => {
        // The whole point of #2418: a client-side filter over a truncated page
        // can only hide rows, never reach the ones the cap cut off. So the
        // evidence is the request, not the rendered subset.
        mockSearchableFetch((url) =>
            url.includes('q=zoe') ? [account({ id: 'z', email: 'zoe@acme.test' })] : fill(2),
        );
        render(<IdentityAccountsPage />);
        await screen.findByText('user0@acme.test');

        fireEvent.change(await openSearch(), { target: { value: 'zoe' } });

        await waitFor(() => {
            expect(rosterCalls().some((u) => u.includes('q=zoe'))).toBe(true);
        });
        // And the row that was never in the first page is now on screen.
        expect(await screen.findByText('zoe@acme.test')).toBeInTheDocument();
    });

    it('says "no matches" for an empty SEARCH, not "no synced accounts yet"', async () => {
        // Two different sentences because they mean different things. Telling
        // an operator the directory is unsynced when their search simply
        // matched nothing is the same false absence the cap used to produce.
        mockSearchableFetch((url) => (url.includes('q=') ? [] : fill(2)));
        render(<IdentityAccountsPage />);
        await screen.findByText('user0@acme.test');

        fireEvent.change(await openSearch(), { target: { value: 'nobody' } });

        expect(await screen.findByText(/No accounts match this search/i)).toBeInTheDocument();
        expect(screen.queryByText(/No synced accounts yet/i)).not.toBeInTheDocument();
    });
});
