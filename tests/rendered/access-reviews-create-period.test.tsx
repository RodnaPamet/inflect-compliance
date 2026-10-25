/**
 * The create form sends the audit period (#4130).
 *
 * Every create schema accepts `periodStartAt` / `periodEndAt` and the evidence
 * PDF prints them, but the form had no field for it, so the register's Period
 * column read "—" for every campaign ever created from the page. The form now
 * carries a `<DateRangePicker>`; this proves what it sends.
 *
 * The picker and the people-picker are replaced by plain controls: the shared
 * primitives have their own tests, and here they are only the levers that put
 * a range and a reviewer into the request.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/access-reviews',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const t = (key: string) => key;
    (t as unknown as { rich: (k: string) => string }).rich = (key: string) => key;
    return { useTranslations: () => t, useLocale: () => 'en' };
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

const fetchMock = jest.fn();

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            return { ok: true, status: 201, json: async () => ({ accessReviewId: 'rev_new', snapshotCount: 3 }) };
        }
        return { ok: true, json: async () => ({ rows: [], truncated: false, accounts: [] }) };
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

function renderList() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <AccessReviewsClient tenantSlug="acme" canCreate initialReviews={[]} />
        </SWRConfig>,
    );
}

function postedBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(call).toBeDefined();
    return JSON.parse(String((call![1] as RequestInit).body));
}

describe('the create form and the audit period', () => {
    it('sends the chosen period as periodStartAt / periodEndAt', async () => {
        renderList();
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
        fireEvent.change(screen.getByTestId('access-review-new-name'), { target: { value: 'Q3 review' } });
        fireEvent.click(screen.getByTestId('pick-reviewer'));
        fireEvent.click(screen.getByTestId('pick-period'));
        fireEvent.click(screen.getByTestId('access-review-new-submit'));

        await waitFor(() => expect(postedBody()).toBeDefined());
        expect(postedBody()).toMatchObject({
            name: 'Q3 review',
            scope: 'ALL_USERS',
            reviewerUserId: 'usr_reviewer',
            periodStartAt: RANGE.from.toISOString(),
            periodEndAt: RANGE.to.toISOString(),
        });
    });

    it('sends no period when none was chosen', async () => {
        renderList();
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
        fireEvent.change(screen.getByTestId('access-review-new-name'), { target: { value: 'Q3 review' } });
        fireEvent.click(screen.getByTestId('pick-reviewer'));
        fireEvent.click(screen.getByTestId('access-review-new-submit'));

        await waitFor(() => expect(postedBody()).toBeDefined());
        const body = postedBody();
        expect('periodStartAt' in body).toBe(false);
        expect('periodEndAt' in body).toBe(false);
    });
});
