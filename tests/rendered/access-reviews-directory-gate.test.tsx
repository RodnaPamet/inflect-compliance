/**
 * The directory gate in the access-reviews "New campaign" modal.
 *
 * A CONNECTED_APP review runs over accounts synced from an identity
 * provider, so the server refuses one whose scope would have zero subjects.
 * The gate is the client-side half of that: it reads the synced-account
 * roster and, once it knows the sync status of every directory, disables the
 * ones with nothing synced and offers a "connect a directory" link instead of
 * letting the operator fill in the whole form and fail on submit.
 *
 * It was inert for its entire life. The reader asked `Array.isArray(data)` of
 * a response the route sends as `{ accounts }`, so the roster was never
 * recognised, the known-flag was never true, and no option was ever disabled.
 * It failed OPEN, which is exactly why nobody noticed: "the gate never fired"
 * and "nothing needed gating" render identically.
 *
 * That is what shapes this file. Every check that something is ABSENT or
 * PERMITTED is paired, in the same test, with a check that the gate does fire
 * on a body that should trip it — otherwise the assertion would have passed
 * against the broken build it exists to catch.
 */
import * as React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/access-reviews',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = en[ns] || {};
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
                dict,
            );
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(key);
            return typeof v === 'string' ? v : key;
        };
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// The modal reads through `useTenantSWR`, which resolves the tenant-relative
// path via `useTenantApiUrl`. Mocking that seam keeps the test free of a
// TenantProvider while leaving the prefixing itself observable — see the
// tenant-relative-path assertion below.
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { AccessReviewsClient } from '@/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient';
import { IDENTITY_ROSTER_PAGE_SIZE } from '@/lib/identity-roster';

const ROSTER_PATH = '/admin/integrations/identity-accounts';
const NOTICE = 'access-review-no-directories';

/** The wire shape of the roster route: `jsonResponse({ accounts })`. */
const roster = (accounts: Array<{ provider: string; status: string }>) => ({ accounts });

const account = (provider: string, status = 'ACTIVE') => ({ provider, status });

/** Answer the roster fetch with `body`; everything else gets an empty list. */
function mockFetch(body: unknown | 'pending') {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: unknown) => {
        if (String(url).includes(ROSTER_PATH)) {
            if (body === 'pending') return new Promise(() => {});
            return { ok: true, json: async () => body };
        }
        // The campaign list and the reviewer people-picker also fetch.
        return { ok: true, json: async () => ({ rows: [], truncated: false }) };
    });
}

/** Mount the page, open the create modal, switch to CONNECTED_APP, open the picker. */
async function openDirectoryPicker(body: unknown | 'pending') {
    mockFetch(body);
    render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <AccessReviewsClient tenantSlug="acme" initialReviews={[]} />
        </SWRConfig>,
    );
    fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
    // CONNECTED_APP is the only scope that shows a directory picker.
    fireEvent.click(screen.getByText('Connected directory accounts'));
    const field = await screen.findByTestId('access-review-new-directory');
    fireEvent.click(within(field).getByRole('combobox'));
    await waitFor(() => expect(options().length).toBe(ALL_VALUES.length));
}

function options(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

/**
 * The option for one directory. cmdk stamps `data-value` as label+value, so
 * the provider id is a stable suffix that survives label copy changes.
 */
function option(value: string): HTMLElement {
    const hits = options().filter((o) => (o.getAttribute('data-value') ?? '').endsWith(value));
    if (hits.length !== 1) {
        throw new Error(
            `expected exactly one option for "${value}", got ${hits.length} of ` +
                `[${options().map((o) => o.getAttribute('data-value')).join(', ')}]`,
        );
    }
    return hits[0];
}

const blocked = (value: string) => option(value).getAttribute('aria-disabled') === 'true';

/** Every directory the picker offers, in the order it offers them. */
const ALL_VALUES = ['all', 'okta', 'google-workspace', 'entra-id', 'active-directory'];

// `tests/rendered/setup.ts` already registers an afterEach cleanup; the
// explicit `cleanup()` calls below are the ones that matter — they end one
// mount so the next can be compared against it inside a single test.

describe('access-reviews directory gate', () => {
    it('offers the connect route and blocks every directory when nothing is synced', async () => {
        await openDirectoryPicker(roster([]));

        // The notice the operator needs, with the link that fixes the problem.
        const notice = await screen.findByTestId(NOTICE);
        expect(notice.textContent).toContain('No directory has synced accounts yet');
        expect(
            document.getElementById('access-review-connect-directory-link')?.getAttribute('href'),
        ).toBe('/t/acme/admin/integrations/identity-accounts');

        // …and nothing is selectable, including the 'all' scope.
        for (const value of ALL_VALUES) expect(blocked(value)).toBe(true);

        // The roster is read TENANT-RELATIVELY. An absolute path here would
        // double-prefix the tenant segment, 404 silently, and take the whole
        // gate down — the failure mode the comment above the fetch warns of.
        const urls = (global.fetch as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
        expect(urls).toContain(`/api/t/acme${ROSTER_PATH}`);
        expect(urls.filter((u) => u.includes('/acme/api/'))).toEqual([]);
    });

    it('permits the synced directory and blocks the rest', async () => {
        await openDirectoryPicker(roster([account('okta')]));

        // Positive: the gate resolved the roster and let Okta through.
        await waitFor(() => expect(blocked('google-workspace')).toBe(true));
        expect(blocked('okta')).toBe(false);
        expect(blocked('all')).toBe(false);
        // Positive: it decided AGAINST the others, which have nothing synced.
        expect(blocked('entra-id')).toBe(true);
        expect(blocked('active-directory')).toBe(true);
        // …so the "nothing synced" notice must be gone.
        expect(screen.queryByTestId(NOTICE)).toBeNull();
    });

    it('counts only ACTIVE accounts as synced', async () => {
        // A deprovisioned roster is a roster the server would refuse: it
        // filters on status ACTIVE when it builds the campaign's subjects.
        await openDirectoryPicker(roster([account('okta', 'DEPROVISIONED')]));

        expect(await screen.findByTestId(NOTICE)).toBeTruthy();
        expect(blocked('okta')).toBe(true);
    });

    it('fails open when the roster is unresolved or unrecognised', async () => {
        // Baseline FIRST, so the two absences below are attributable to the
        // body rather than to a gate that simply never runs in this harness.
        await openDirectoryPicker(roster([]));
        expect(await screen.findByTestId(NOTICE)).toBeTruthy();
        cleanup();

        // Still in flight — "not synced" is not yet distinguishable from
        // "not loaded", and disabling on the latter blocks a usable directory.
        await openDirectoryPicker('pending');
        for (const value of ALL_VALUES) expect(blocked(value)).toBe(false);
        expect(screen.queryByTestId(NOTICE)).toBeNull();
        cleanup();

        // A body this reader does not understand — e.g. the route grows a
        // `{ rows, truncated }` envelope. Better un-gated than gated on a
        // guess.
        await openDirectoryPicker({ rows: [], truncated: false });
        for (const value of ALL_VALUES) expect(blocked(value)).toBe(false);
        expect(screen.queryByTestId(NOTICE)).toBeNull();
    });

    it('stands down when the roster came back at the page cap', async () => {
        const fill = (n: number) =>
            roster(Array.from({ length: n }, () => account('active-directory')));

        // One row short of the cap: the roster is whole, so absence is real
        // and Okta is correctly blocked.
        await openDirectoryPicker(fill(IDENTITY_ROSTER_PAGE_SIZE - 1));
        await waitFor(() => expect(blocked('okta')).toBe(true));
        expect(blocked('active-directory')).toBe(false);
        cleanup();

        // At the cap the response carries no `truncated` flag, so a provider
        // sorting after 'active-directory' may simply have been cut off.
        // Absence in a capped list is not evidence of absence.
        await openDirectoryPicker(fill(IDENTITY_ROSTER_PAGE_SIZE));
        for (const value of ALL_VALUES) expect(blocked(value)).toBe(false);
        expect(screen.queryByTestId(NOTICE)).toBeNull();
    });
});
