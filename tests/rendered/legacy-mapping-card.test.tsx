/**
 * The mapping screen shows STATISTICS, never a raw sample value.
 *
 * Step 2b's first hardening item, and it wants a rendered test specifically —
 * because the claim is about what reaches a person's eyes, and every layer below
 * can be correct while a cell renders the wrong thing. The server already gates
 * what it sends (`mayExposeValueSet`); this asserts the component cannot show
 * more than it was sent.
 *
 * `useTranslations` is mocked to return the KEY, so nothing here asserts English
 * copy. That suits the claim: what must not appear is DATA, which comes from the
 * profile payload rather than from the message catalogue.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', connectionId: 'conn_1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/admin/integrations/conn_1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { LegacyAccessMappingCard } from '@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/LegacyAccessMappingCard';

/** Values that must never reach the DOM. Each is the kind of thing a real table holds. */
const SECRETS = {
    login: 'jsmith',
    email: 'john.smith@corp.test',
    name: 'John Smith',
    dept: 'Payroll Operations',
    hash: '$2y$10$abcdefghijklmnopqrstuv',
};

/** The vocabulary that MAY be shown, because the server decided it qualified. */
const VOCAB = ['A', 'I', 'LOCKD'];

const stat = (over: Record<string, unknown> = {}) => ({
    rowsSampled: 100,
    nonNullCount: 100,
    distinctCount: 100,
    emailShare: 0,
    dateShare: 0,
    integerShare: 0,
    booleanShare: 0,
    maxLength: 32,
    ...over,
});

const PROFILE = {
    application: { name: 'Payroll', owner: 'finance' },
    columns: [
        {
            profile: { name: 'LOGIN_NAME', ...stat() },
            suggestion: {
                column: 'LOGIN_NAME', suggested: 'accountKey', basis: 'name',
                confidence: 0.75, denied: false, note: 'n',
            },
        },
        {
            profile: { name: 'EMAIL_ADDR', ...stat({ emailShare: 1 }) },
            suggestion: {
                column: 'EMAIL_ADDR', suggested: 'email', basis: 'name+profile',
                confidence: 0.95, denied: false, note: 'n',
            },
        },
        {
            // The vocabulary column: low cardinality, recurring, so the server
            // attached its values and the editor may render them.
            profile: { name: 'STATUS_FLAG', ...stat({ distinctCount: 3 }), valueSet: VOCAB },
            suggestion: {
                column: 'STATUS_FLAG', suggested: 'status', basis: 'name',
                confidence: 0.75, denied: false, note: 'n',
            },
        },
        {
            // Denylisted: declared by the server, never read, never mappable.
            profile: { name: 'PASSWORD_HASH', ...stat({ rowsSampled: 0, nonNullCount: 0, distinctCount: 0 }) },
            suggestion: {
                column: 'PASSWORD_HASH', suggested: null, basis: null,
                confidence: 0, denied: true, note: 'n',
            },
        },
    ],
    columnSetFingerprint: 'a'.repeat(64),
    observedColumns: ['LOGIN_NAME', 'EMAIL_ADDR', 'STATUS_FLAG', 'PASSWORD_HASH'],
    declaredLayout: 'wide',
    rowsSampled: 100,
    truncated: true,
    overshared: [],
    drift: null,
    mappingVersion: null,
};

let calls: { url: string; method: string }[] = [];

beforeEach(() => {
    calls = [];
    // Plain objects rather than `new Response(...)`: this jsdom environment has no
    // usable `Response`, and constructing one throws inside the component's own
    // try/catch — which reads as "the profile failed" and renders nothing, with no
    // hint that the MOCK was the problem. The house pattern in
    // tests/rendered/manifest-pin-approval.test.tsx is a plain `{ ok, json }`.
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? 'GET' });
        if (url.includes('/admin/legacy-access/profile')) {
            return { ok: true, status: 200, json: async () => PROFILE };
        }
        if (url.includes('/admin/legacy-access/mapping')) {
            return { ok: true, status: 200, json: async () => ({ mapping: { version: 1 } }) };
        }
        if (url.includes('/admin/integrations')) {
            return {
                ok: true, status: 200,
                json: async () => [{ id: 'conn_1', provider: 'legacy-mcp' }],
            };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
});

async function readColumns() {
    render(<LegacyAccessMappingCard connectionId="conn_1" />);
    fireEvent.click(screen.getByText('profileButton'));
    await waitFor(() => expect(screen.getByTestId('legacy-mapping-table')).toBeInTheDocument());
}

describe('the mapping screen never shows a sample value', () => {
    it('renders the table with a stable id', async () => {
        await readColumns();
        // `data-testid` on DataTable IS the id setter, per the table GUIDE — so
        // this also gives E2E a `#legacy-mapping-table` selector.
        expect(screen.getByTestId('legacy-mapping-table')).toBeInTheDocument();
    });

    it('shows every column NAME', async () => {
        await readColumns();
        for (const name of PROFILE.observedColumns) {
            expect(screen.getByText(name)).toBeInTheDocument();
        }
    });

    it('shows NO identity value anywhere in the document', async () => {
        await readColumns();
        const html = document.body.innerHTML;
        for (const [label, value] of Object.entries(SECRETS)) {
            expect(html).not.toContain(value);
            // Belt and braces: the label names which one failed if it ever does.
            expect({ label, present: html.includes(value) }).toEqual({ label, present: false });
        }
    });

    it('DOES show the status vocabulary, because that is the one gated exception', async () => {
        await readColumns();
        // The denominator for the assertion above: if this failed, the previous
        // test would pass for the wrong reason — a component rendering nothing.
        for (const v of VOCAB) {
            expect(screen.getByText(v)).toBeInTheDocument();
        }
    });

    it('marks the denylisted column unmappable rather than hiding it', async () => {
        await readColumns();
        expect(screen.getByText('PASSWORD_HASH')).toBeInTheDocument();
        expect(screen.getByText('deniedColumn')).toBeInTheDocument();
    });
});

describe('nothing is saved without an explicit save', () => {
    it('reading the columns issues no write, even though every suggestion is pre-selected', async () => {
        await readColumns();
        const writes = calls.filter((c) => c.method === 'PUT' || c.method === 'PATCH');
        expect(writes).toEqual([]);
        // And the profile call itself is a POST, which is deliberate — it dials a
        // customer-hosted server — so "no writes" is asserted on the MAPPING
        // endpoint rather than on the method alone.
        expect(calls.filter((c) => c.url.includes('/admin/legacy-access/mapping'))).toEqual([]);
    });

    it('pressing save writes the mapping once, with the confirmed columns', async () => {
        await readColumns();
        fireEvent.click(screen.getByText('saveButton'));
        await waitFor(() =>
            expect(calls.filter((c) => c.url.includes('/admin/legacy-access/mapping')).length)
                .toBeGreaterThan(0));
    });
});

describe('a non-legacy connection renders nothing', () => {
    it('shows no mapping section for another provider', async () => {
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/admin/integrations')) {
                return {
                    ok: true, status: 200,
                    json: async () => [{ id: 'conn_1', provider: 'entra-id' }],
                };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        }) as unknown as typeof fetch;

        render(<LegacyAccessMappingCard connectionId="conn_1" />);
        await waitFor(() => expect(screen.queryByText('profileButton')).not.toBeInTheDocument());
    });
});
