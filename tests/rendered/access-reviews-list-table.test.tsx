/**
 * The Access reviews register's table and create form (#4464).
 *
 *   - The table's resource noun, which its footer and empty fallback read, is
 *     translated. It was the English literal "access reviews" in every locale.
 *   - The table has no row selection: nothing on the page acts on ticked rows,
 *     and the select column is on by default.
 *   - The New campaign form's name and description are the shared `Input` /
 *     `Textarea` primitives (Epic 55), not raw elements with the legacy
 *     `input` class.
 *
 * Translations resolve against the Bulgarian catalogue, so an English literal
 * cannot pass for a translated label.
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/access-reviews',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const bg = require('../../messages/bg.json');
    const make = (ns?: string) => {
        const base = ns ? ns.split('.').reduce((o: Record<string, unknown>, k) => o?.[k] as Record<string, unknown>, bg) : bg;
        const resolve = (key: string) =>
            key.split('.').reduce((o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), base);
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = resolve(key);
            if (typeof v !== 'string') return key;
            return Object.entries(params ?? {}).reduce((s, [p, val]) => s.replace(`{${p}}`, String(val)), v);
        };
        (t as unknown as { rich: (k: string) => string }).rich = (key: string) => {
            const v = resolve(key);
            return typeof v === 'string' ? v.replace(/<(\w+)>(.*?)<\/\1>/g, '$2') : key;
        };
        (t as unknown as { has: (k: string) => boolean }).has = (key: string) => typeof resolve(key) === 'string';
        return t;
    };
    return { useTranslations: make, useLocale: () => 'bg' };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

// Capture what the register hands its table, then render the real one.
const tableProps: Array<Record<string, unknown>> = [];
jest.mock('@/components/ui/table', () => {
    const actual = jest.requireActual('@/components/ui/table');
    const ReactActual = jest.requireActual('react');
    return {
        ...actual,
        DataTable: (props: Record<string, unknown>) => {
            tableProps.push(props);
            return ReactActual.createElement(actual.DataTable, props);
        },
    };
});

import { AccessReviewsClient } from '@/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient';

const bg = require('../../messages/bg.json');

const REVIEWS = [
    {
        id: 'rev_1',
        name: 'Q3 review',
        scope: 'ALL_USERS' as const,
        status: 'OPEN' as const,
        periodStartAt: null,
        periodEndAt: null,
        dueAt: null,
        closedAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        reviewerUserId: 'usr_1',
        createdByUserId: 'usr_1',
        _count: { decisions: 4, connectedDecisions: 0 },
        decidedCount: 1,
    },
    {
        id: 'rev_2',
        name: 'Q2 review',
        scope: 'ADMIN_ONLY' as const,
        status: 'CLOSED' as const,
        periodStartAt: null,
        periodEndAt: null,
        dueAt: null,
        closedAt: '2026-07-01T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
        reviewerUserId: 'usr_1',
        createdByUserId: 'usr_1',
        _count: { decisions: 2, connectedDecisions: 0 },
        decidedCount: 2,
    },
];

beforeEach(() => {
    tableProps.length = 0;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ rows: REVIEWS, truncated: false, accounts: [] }),
    }));
});

function renderList(canCreate = false) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, revalidateOnMount: false }}>
            <AccessReviewsClient tenantSlug="acme" canCreate={canCreate} initialReviews={REVIEWS} />
        </SWRConfig>,
    );
}

function lastTableProps(): Record<string, unknown> {
    expect(tableProps.length).toBeGreaterThan(0);
    return tableProps[tableProps.length - 1];
}

describe('the register table', () => {
    it('names its rows in the reader\'s language', () => {
        renderList();
        const resourceName = lastTableProps().resourceName as (plural: boolean) => string;
        expect(resourceName(true)).toBe(bg.accessReviews.resourcePlural);
        expect(resourceName(false)).toBe(bg.accessReviews.resourceSingular);
        expect(resourceName(true)).not.toMatch(/access review/i);
    });

    it('has no row selection', () => {
        renderList();
        expect(lastTableProps().selectionEnabled).toBe(false);
        const table = screen.getByTestId('access-reviews-table');
        expect(within(table).getByText('Q3 review')).toBeTruthy();
        expect(within(table).queryAllByRole('checkbox')).toHaveLength(0);
    });
});

describe('the New campaign form', () => {
    it('uses the shared Input and Textarea primitives', () => {
        renderList(true);
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));

        const name = screen.getByTestId('access-review-new-name');
        expect(name.tagName).toBe('INPUT');
        expect(name.classList.contains('input')).toBe(false);
        // The Input primitive's own surface, not the legacy class.
        expect(name.classList.contains('text-content-emphasis')).toBe(true);

        const description = screen.getByPlaceholderText(bg.accessReviews.descPlaceholder);
        expect(description.tagName).toBe('TEXTAREA');
        expect(description.classList.contains('input')).toBe(false);
        expect(description.classList.contains('text-content-emphasis')).toBe(true);

        // Still labelled by its FormField.
        expect(screen.getByLabelText(new RegExp(bg.accessReviews.fieldName))).toBe(name);
    });
});
