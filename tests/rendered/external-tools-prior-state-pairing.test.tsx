/**
 * Nominating the read that runs before a write, on the page an operator uses
 * (#2982).
 *
 * The dispatch REFUSES a write with no prior-state read paired to it, so this
 * control is the difference between a write tool that works and one that is
 * permanently inert. Until it existed the only way to create a pairing was a
 * hand-written request — the same gap that made #2921's approval API unusable,
 * on this same page.
 *
 * Four properties, each of which passes a source scan while being visibly
 * broken, which is why they are rendered tests rather than guards:
 *
 *   1. the control appears ONLY for tools the server declares as writes;
 *   2. the options are that server's READ tools, never the writes;
 *   3. an unpaired write SAYS it cannot run, rather than looking merely unset;
 *   4. a refusal shows the SERVER's sentence, because every one of them names
 *      something specific the operator can act on.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/agents/external-tools',
    useSearchParams: () => new URLSearchParams(),
}));

// Interpolating `t`. A mock that returned the raw key would leave every
// assertion below reading "externalTools.priorStateMissing" and passing without
// ever proving the copy says anything.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = (en as Record<string, unknown>)[ns] ?? {};
        const t = (key: string, values?: Record<string, string | number>) => {
            const v = key.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
            if (typeof v !== 'string') return key;
            return values ? v.replace(/\{(\w+)\}/g, (m, n) => (n in values ? String(values[n]) : m)) : v;
        };
        t.rich = t;
        return t;
    };
    // MEMOISED per namespace, for the same reason the provider mock below is.
    // `loadCatalogue` is a useCallback over [apiUrl, connectionId, t] and an
    // effect depends on it, so a fresh `t` each render rebuilds the callback,
    // re-fires the effect, and its first line -- setTools(null) -- blanks the
    // list. That surfaced as "the row vanishes after a refusal": a component
    // bug that did not exist, invented by the mock.
    const cache = new Map<string, ReturnType<typeof make>>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns)!;
        },
        useLocale: () => 'en',
    };
});

/**
 * STABLE function identities, and that is not a detail.
 *
 * Returning `(path) => ...` fresh from each hook call gives `apiUrl` a new
 * identity on every render, so `loadCatalogue`'s `useCallback` is rebuilt every
 * render and the effect that depends on it re-fires in a loop. Its first line is
 * `setTools(null)`, so the tool list blinks out constantly — which surfaced as
 * "the row disappeared after the server refused", a component bug that did not
 * exist. The real provider memoises these; the mock has to as well, or the test
 * measures the mock.
 */
const stableApiUrl = (path: string) => `/api/t/acme${path}`;
const stableHref = (path: string) => `/t/acme${path}`;
const stablePermissions = { admin: { manage: true, tenant_lifecycle: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => stableApiUrl,
    useTenantHref: () => stableHref,
    usePermissions: () => stablePermissions,
}));

import { ExternalToolsClient } from '@/app/t/[tenantSlug]/(app)/agents/external-tools/ExternalToolsClient';

const CONN = 'conn_1';
const WRITE = `mcp__${CONN}__set_employee_work_email`;
const READ_A = `mcp__${CONN}__get_employee_contact`;
const READ_B = `mcp__${CONN}__get_employee_job`;

const tool = (name: string, declaresWrite: boolean) => ({
    toolName: `mcp__${CONN}__${name}`,
    advertisedName: name,
    declaresWrite,
    status: 'APPROVED',
    blocked: false,
    liveDescription: `${name} does a thing.`,
    liveSchema: '{}',
    liveManifestHash: 'h1',
    approvedManifestHash: 'h1',
    approvedAt: null,
    revision: 1,
});

const CATALOGUE = {
    tools: [
        tool('get_employee_contact', false),
        tool('get_employee_job', false),
        tool('set_employee_work_email', true),
    ],
};

/** Route the two GETs the page makes; `pairings` is what the setter has stored. */
function mockFetch(opts: { pairings?: Array<{ writeToolName: string; readToolName: string }>; failWith?: string } = {}) {
    global.fetch = jest.fn(async (url: string, init?: { method?: string }) => {
        const u = String(url);
        if (u.includes('/admin/agents/external-tools')) {
            return { ok: true, json: async () => CATALOGUE };
        }
        if (u.includes('/admin/external-prior-state-read')) {
            if (init?.method && opts.failWith) {
                return { ok: false, json: async () => ({ error: opts.failWith }) };
            }
            if (init?.method) return { ok: true, json: async () => ({}) };
            return { ok: true, json: async () => ({ pairings: opts.pairings ?? [] }) };
        }
        return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
}

const renderPage = async () => {
    render(
        <ExternalToolsClient
            tenantSlug="acme"
            connections={[{ id: CONN, name: 'HRM', lastTestStatus: null }]}
            canReviewProposals
            canInvestigate
        />,
    );
    // An explicit timeout, not the 1s default. The catalogue and the pairings
    // are two sequential fetches, and the FIRST render in a file carries module
    // loading with it -- so this passed inside the suite and failed when the
    // test was run alone, which is an order dependency rather than a real
    // difference in behaviour.
    await screen.findByTestId('prior-state-pairing-set_employee_work_email', undefined, {
        timeout: 5000,
    });
};

const picker = () =>
    document.getElementById('prior-state-set_employee_work_email') as HTMLSelectElement;

const callsWithMethod = (m: string) =>
    (global.fetch as jest.Mock).mock.calls.filter((c) => c[1]?.method === m);

beforeEach(() => mockFetch());

describe('the control appears only where a write can happen', () => {
    it('is rendered for the tool declared as a WRITE', async () => {
        await renderPage();
        expect(screen.getByTestId('prior-state-pairing-set_employee_work_email')).toBeInTheDocument();
    });

    it('is NOT rendered for the read-only tools, so its presence means something', async () => {
        // The positive control. If it rendered on every row the assertion above
        // would pass while the control said nothing about writes at all.
        await renderPage();
        expect(screen.queryByTestId('prior-state-pairing-get_employee_contact')).not.toBeInTheDocument();
        expect(screen.queryByTestId('prior-state-pairing-get_employee_job')).not.toBeInTheDocument();
    });
});

describe('what an operator may choose', () => {
    it("offers this server's READ tools, and never a write", async () => {
        await renderPage();
        const options = Array.from(picker().options).map((o) => o.value);
        expect(options).toContain(READ_A);
        expect(options).toContain(READ_B);
        // Nominating a WRITE as the prior-state read would send two changes per
        // dispatch, the first of them unjournalled. The setter refuses it; the
        // picker must not offer it in the first place.
        expect(options).not.toContain(WRITE);
    });

    it('PUTs the chosen pairing', async () => {
        await renderPage();
        fireEvent.change(picker(), { target: { value: READ_A } });
        await waitFor(() => {
            const puts = callsWithMethod('PUT');
            expect(puts).toHaveLength(1);
            expect(JSON.parse(puts[0][1].body)).toEqual({ writeToolName: WRITE, readToolName: READ_A });
        });
    });

    it('reflects a pairing the server already holds', async () => {
        // Without this, "clearing" below would be a no-op on an empty control
        // rather than a real transition — and would pass either way.
        mockFetch({ pairings: [{ writeToolName: WRITE, readToolName: READ_A }] });
        await renderPage();
        await waitFor(() => expect(picker().value).toBe(READ_A));
    });

    it('DELETEs when the choice is cleared — one control, not two', async () => {
        mockFetch({ pairings: [{ writeToolName: WRITE, readToolName: READ_A }] });
        await renderPage();
        await waitFor(() => expect(picker().value).toBe(READ_A));

        fireEvent.change(picker(), { target: { value: '' } });
        await waitFor(() => {
            const dels = callsWithMethod('DELETE');
            expect(dels).toHaveLength(1);
            expect(JSON.parse(dels[0][1].body)).toEqual({ writeToolName: WRITE });
        });
    });
});

describe('an unpaired write says it cannot run', () => {
    it('warns, rather than sitting on "None" with no explanation', async () => {
        // The dispatch refuses an unpaired write. A picker showing "None" and
        // nothing else leaves an operator to discover that from a failed run.
        await renderPage();
        const row = screen.getByTestId('prior-state-pairing-set_employee_work_email');
        expect(within(row).getByText(/cannot run/)).toBeInTheDocument();
    });

    it('and stops warning once a pairing exists', async () => {
        // The other half: a warning that never clears is decoration.
        mockFetch({ pairings: [{ writeToolName: WRITE, readToolName: READ_A }] });
        await renderPage();
        const row = screen.getByTestId('prior-state-pairing-set_employee_work_email');
        await waitFor(() => expect(within(row).queryByText(/cannot run/)).not.toBeInTheDocument());
    });
});

describe('a refused pairing', () => {
    it("shows the SERVER's sentence, not a generic failure", async () => {
        // Every refusal the setter raises names something specific — a read on
        // the wrong connection, a write nominated as the read. A generic message
        // sends an operator looking for a bug instead of correcting the choice.
        mockFetch({ failWith: 'The prior-state read must be on the same connection as the write it precedes' });
        await renderPage();
        fireEvent.change(picker(), { target: { value: READ_A } });
        await waitFor(() =>
            expect(screen.getByText(/must be on the same connection/)).toBeInTheDocument(),
        );
    });

    it('and does NOT record the pairing locally when the server refused it', async () => {
        // The failure that would be invisible: optimistically updating state on
        // a refusal leaves the screen claiming a pairing the server does not
        // have, and the warning gone that would have said so.
        // A message that CANNOT collide with the page's own copy. The first
        // version used the word "refused", which also appears in the option
        // text "None — this write is refused" — so the assertion could not tell
        // the server's error from the control's own label.
        mockFetch({ failWith: 'SETTER-SAID-NO' });
        await renderPage();
        fireEvent.change(picker(), { target: { value: READ_A } });
        await waitFor(() => expect(screen.getByText(/SETTER-SAID-NO/)).toBeInTheDocument());

        const row = screen.getByTestId('prior-state-pairing-set_employee_work_email');
        expect(within(row).getByText(/cannot run/)).toBeInTheDocument();
        expect(picker().value).toBe('');
    });
});
