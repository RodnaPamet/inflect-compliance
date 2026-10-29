/**
 * The "New campaign" modal creates a LEGACY_APP campaign.
 *
 * `POST /access-reviews/legacy` (#4377) gave a legacy recertification its HTTP
 * entrance; this is its form. The form chooses one legacy application from the
 * tenant's connections, names a reviewer and optional dates, and posts exactly
 * the fields that route's strict body takes. Every refusal the route can give
 * reaches the person who submitted: the five snapshot refusals, the reviewer
 * rule, and a validation error, which shows its field rather than "Invalid
 * request payload".
 *
 * The people-picker and the range picker are replaced by plain controls, as in
 * `access-reviews-create-period.test.tsx`: they have their own tests, and here
 * they are only the levers that put a reviewer and a period into the request.
 * Copy is read from the real `messages/en.json`, so a missing key fails here.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/access-reviews',
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
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(key);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
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

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

jest.mock('@/components/ui/user-combobox', () => ({
    UserCombobox: ({ onChange }: { onChange: (id: string | null) => void }) => (
        <button type="button" data-testid="pick-reviewer" onClick={() => onChange('usr_reviewer')}>
            pick
        </button>
    ),
}));

const RANGE = {
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-09-30T00:00:00.000Z'),
};
jest.mock('@/components/ui/date-picker/date-range-picker', () => ({
    DateRangePicker: ({ onChange }: { onChange: (v: { from: Date | null; to: Date | null }) => void }) => (
        <button type="button" data-testid="pick-period" onClick={() => onChange(RANGE)}>
            period
        </button>
    ),
}));

import { AccessReviewsClient } from '@/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient';

const EN = require('../../messages/en.json').accessReviews as Record<string, string>;

const CONNECTIONS = {
    connections: [
        { id: 'conn-ledger', provider: 'legacy-mcp', name: 'Ledger' },
        { id: 'conn-okta', provider: 'okta', name: 'Okta production' },
        { id: 'conn-payroll', provider: 'legacy-mcp', name: 'Payroll' },
    ],
};

type Answer = { status: number; body: unknown };
let connectionsAnswer: Answer;
let createAnswer: Answer;
const fetchMock = jest.fn();

beforeEach(() => {
    connectionsAnswer = { status: 200, body: CONNECTIONS };
    createAnswer = { status: 201, body: { accessReviewId: 'rev_legacy', subjectCount: 2 } };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const reply = ({ status, body }: Answer) => ({ ok: status < 400, status, json: async () => body });
        if (init?.method === 'POST') return reply(createAnswer);
        if (String(url).endsWith('/api/t/acme/admin/integrations')) return reply(connectionsAnswer);
        return reply({ status: 200, body: { rows: [], truncated: false, accounts: [] } });
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

function renderList(canCreate = true) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <AccessReviewsClient tenantSlug="acme" canCreate={canCreate} initialReviews={[]} />
        </SWRConfig>,
    );
}

const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

/** Open the modal and choose LEGACY_APP. */
async function openLegacy() {
    fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
    fireEvent.click(document.getElementById('access-review-scope-LEGACY_APP')!);
    await screen.findByTestId('access-review-new-legacy-connection');
}

/** Name, reviewer and period, and — unless told not to — the Ledger application. */
async function fillLegacy({ pickConnection = true } = {}) {
    const user = userEvent.setup();
    await openLegacy();
    fireEvent.change(screen.getByTestId('access-review-new-name'), { target: { value: 'Q3 ledger' } });
    fireEvent.click(screen.getByTestId('pick-reviewer'));
    fireEvent.click(screen.getByTestId('pick-period'));
    if (pickConnection) {
        await user.click(document.getElementById('access-review-legacy-connection-select')!);
        const listbox = await screen.findByRole('listbox');
        await user.click(within(listbox).getByRole('option', { name: 'Ledger' }));
    }
}

describe('the LEGACY_APP option follows the create permission', () => {
    it('is offered, labelled, to a caller holding access_reviews.create', () => {
        renderList(true);
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
        const option = document.getElementById('access-review-scope-LEGACY_APP');
        expect(option).not.toBeNull();
        expect(option!.closest('label')).toHaveTextContent(EN.scopeLegacyApp);
    });

    it('is not offered at all to a caller without it', () => {
        renderList(false);
        expect(screen.queryByTestId('access-review-new-campaign-button')).not.toBeInTheDocument();
        expect(document.getElementById('access-review-scope-LEGACY_APP')).toBeNull();
    });
});

describe('the application picker', () => {
    it('lists the tenant\'s legacy applications, and nothing else', async () => {
        const user = userEvent.setup();
        renderList();
        await openLegacy();
        await user.click(document.getElementById('access-review-legacy-connection-select')!);
        const listbox = await screen.findByRole('listbox');
        const names = within(listbox).getAllByRole('option').map((o) => o.textContent?.trim()).sort();
        expect(names).toEqual(['Ledger', 'Payroll']);
        expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('/api/t/acme/admin/integrations');
    });

    it('says so, with the way to connect one, when there is none', async () => {
        connectionsAnswer = { status: 200, body: { connections: [CONNECTIONS.connections[1]] } };
        renderList();
        await openLegacy();
        const notice = await screen.findByTestId('access-review-no-legacy-connections');
        expect(notice).toHaveTextContent(EN.legacyConnectionsNone);
        expect(document.getElementById('access-review-connect-legacy-link')).toHaveAttribute('href', '/t/acme/admin/integrations');
        expect(screen.queryByTestId('access-review-legacy-connections-unavailable')).not.toBeInTheDocument();
    });

    it('says the list could not be read, rather than that there is none, when the read is refused', async () => {
        connectionsAnswer = { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Permission denied' } } };
        renderList();
        await openLegacy();
        expect(await screen.findByTestId('access-review-legacy-connections-unavailable')).toHaveTextContent(EN.legacyConnectionsUnavailable);
        expect(screen.queryByTestId('access-review-no-legacy-connections')).not.toBeInTheDocument();
    });
});

describe('submitting', () => {
    it('posts exactly the legacy route\'s fields to /access-reviews/legacy', async () => {
        renderList();
        await fillLegacy();
        fireEvent.click(screen.getByTestId('access-review-new-submit'));

        await waitFor(() => expect(posts()).toHaveLength(1));
        const [url, init] = posts()[0];
        expect(url).toBe('/api/t/acme/access-reviews/legacy');
        // The route's body schema is strict: a scope, a provider or a
        // membership list would be a 400, so none may ride along.
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({
            name: 'Q3 ledger',
            connectionId: 'conn-ledger',
            reviewerUserId: 'usr_reviewer',
            periodStartAt: RANGE.from.toISOString(),
            periodEndAt: RANGE.to.toISOString(),
        });
    });

    it('asks for the application before posting anything', async () => {
        renderList();
        await fillLegacy({ pickConnection: false });
        fireEvent.click(screen.getByTestId('access-review-new-submit'));

        expect(await screen.findByTestId('access-review-new-error')).toHaveTextContent(EN.legacyConnectionRequired);
        expect(posts()).toHaveLength(0);
    });
});

describe('every refusal shows its own message, never a generic one', () => {
    it.each([
        'NO_SNAPSHOT: connection conn-ledger has never been pulled',
        'SNAPSHOT_INCOMPLETE: the latest pull is PARTIAL; a campaign over a partial population would certify "every account" about some of them',
        'SNAPSHOT_STALE: the latest COMPLETE pull finished 2026-10-01T00:00:00.000Z, outside the 2-day window',
        'NOT_RECONCILED: snapshot snap-1 has no reconciliation run',
        'NO_SUBJECTS: snapshot snap-1 holds no accounts',
        'REVIEWER_NOT_A_MEMBER: the reviewer must be an active member of this workspace.',
    ])('%s', async (message) => {
        createAnswer = { status: 400, body: { error: { code: 'BAD_REQUEST', message, requestId: 'req-1' } } };
        renderList();
        await fillLegacy();
        fireEvent.click(screen.getByTestId('access-review-new-submit'));

        const shown = await screen.findByTestId('access-review-new-error');
        expect(shown).toHaveTextContent(message);
        expect(shown).not.toHaveTextContent(EN.createFailed);
    });

    it('a validation error names its field and says what was wrong', async () => {
        createAnswer = {
            status: 400,
            body: {
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request payload',
                    details: [{ path: ['periodEndAt'], code: 'custom', message: 'periodEndAt must not precede periodStartAt.' }],
                },
            },
        };
        renderList();
        await fillLegacy();
        fireEvent.click(screen.getByTestId('access-review-new-submit'));

        const shown = await screen.findByTestId('access-review-new-error');
        expect(shown).toHaveTextContent(
            EN.createInvalidFields.replace('{details}', 'periodEndAt: periodEndAt must not precede periodStartAt.'),
        );
        expect(shown).not.toHaveTextContent('Invalid request payload');
    });
});
