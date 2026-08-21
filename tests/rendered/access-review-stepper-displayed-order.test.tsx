/**
 * #99 — the access-review campaign stepper walks the register's order.
 *
 * This register is the one page in the #99 set where the #107 FALLBACK is
 * deliberately left on: `/access-reviews` is a genuine SWR resource in the
 * `CappedList` shape the hook unwraps, so a campaign opened by deep link or
 * from a notification still gets server order rather than nothing.
 *
 * That makes the discriminating case the CAP, not a filter. The register is
 * backfill-capped — it renders the rows it was given and flags `truncated` —
 * so the published order can be SHORTER than what a later list read returns.
 * The stepper must never offer a campaign the register did not list, which is
 * only true if the published order wins over the fallback.
 */
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

// Memoized `t` per namespace — the global next-intl mock hands back a fresh
// `t` each render, which makes page-level suites loop rather than fail.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    if (typeof val === 'function') continue;
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
                }
            }
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            let s = v as string;
            let prev: string;
            do {
                prev = s;
                s = s.replace(/<[^<>]*>/g, '');
            } while (s !== prev);
            return s;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockReplace = jest.fn();
// `useParams` is required: the published order is tenant-scoped through the
// route slug, so publisher and reader only meet when both resolve it.
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: (...a: unknown[]) => mockReplace(...a),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/access-reviews',
    useSearchParams: () => new URLSearchParams(),
}));

/**
 * One seam for BOTH mounts, so the list and the detail can be given different
 * answers for the same key — which is exactly the cap scenario: the register
 * rendered three, a later read returns four.
 */
let listAnswer: { rows: unknown[]; truncated: boolean } = { rows: [], truncated: false };
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: unknown, opts?: { fallbackData?: unknown }) => {
        if (key == null) return { data: undefined, isLoading: false, error: null, mutate: jest.fn() };
        if (typeof key === 'string' && key === '/access-reviews') {
            return { data: listAnswer, isLoading: false, error: null, mutate: jest.fn() };
        }
        return {
            data: (opts as { fallbackData?: unknown } | undefined)?.fallbackData,
            isLoading: false,
            error: null,
            mutate: jest.fn(),
        };
    },
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { AccessReviewsClient } from '@/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient';
import { AccessReviewDetailClient } from '@/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient';

const summary = (id: string, name: string) => ({
    id,
    name,
    scope: 'ALL_USERS' as const,
    status: 'OPEN' as const,
    periodStartAt: null,
    periodEndAt: null,
    dueAt: null,
    closedAt: null,
    createdAt: new Date('2026-04-01').toISOString(),
    reviewerUserId: 'usr_reviewer',
    createdByUserId: 'usr_creator',
    _count: { decisions: 0 },
});

/** What the register rendered — capped at three. */
const DISPLAYED = [
    summary('rev_1', 'Q1 access review'),
    summary('rev_2', 'Q2 access review'),
    summary('rev_3', 'Q3 access review'),
];
/** What a later, uncapped list read returns. `rev_4` was never on screen. */
const BEYOND_CAP = [...DISPLAYED, summary('rev_4', 'Q4 access review')];

function detail(id: string, name: string) {
    return {
        id,
        name,
        description: null,
        scope: 'ALL_USERS' as const,
        status: 'OPEN' as const,
        periodStartAt: null,
        periodEndAt: null,
        dueAt: null,
        closedAt: null,
        createdAt: new Date('2026-04-01').toISOString(),
        reviewerUserId: 'usr_reviewer',
        evidenceFileRecordId: null,
        reviewer: { id: 'usr_reviewer', email: 'r@example.test', name: null },
        createdBy: { id: 'usr_admin', email: 'a@example.test', name: null },
        closedBy: null,
        decisions: [],
        lastActivityByUser: null,
    } as unknown as Parameters<typeof AccessReviewDetailClient>[0]['initialReview'];
}

function makeSharedCache() {
    const cache = new Map();
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
                {children}
            </SWRConfig>
        );
    };
}

beforeEach(() => {
    mockReplace.mockReset();
    listAnswer = { rows: DISPLAYED, truncated: true };
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ rows: [], truncated: false }),
    }));
});

describe('access-review stepper', () => {
    it('walks the campaigns the register displayed and stops at the cap', () => {
        const Wrapper = makeSharedCache();

        const list = render(
            <Wrapper>
                <AccessReviewsClient tenantSlug="acme" initialReviews={DISPLAYED} />
            </Wrapper>,
        );
        // Derive the order from the DOM rather than restating the literal.
        const rendered = DISPLAYED.map((r) => r.id).filter((id) =>
            list.container.querySelector(`[data-testid="access-review-row-${id}"]`),
        );
        expect(rendered).toEqual(['rev_1', 'rev_2', 'rev_3']);
        list.unmount();

        // A later read would now return four. The stepper must not care.
        listAnswer = { rows: BEYOND_CAP, truncated: false };

        render(
            <Wrapper>
                <AccessReviewDetailClient
                    tenantSlug="acme"
                    initialReview={detail('rev_3', 'Q3 access review')}
                    currentUserId="usr_reviewer"
                    isAdmin
                />
            </Wrapper>,
        );

        expect(screen.getByTestId('entity-prev-next-nav')).toBeInTheDocument();
        // rev_3 is the LAST row the register showed, so forward is a dead end
        // — offering rev_4 here would be offering a row the user never saw.
        expect(screen.getByTestId('entity-nav-next')).toBeDisabled();

        fireEvent.click(screen.getByTestId('entity-nav-prev'));
        expect(mockReplace).toHaveBeenCalledWith(
            `/t/acme/access-reviews/${rendered[rendered.indexOf('rev_3') - 1]}`,
        );
    });

    it('falls back to list order for a campaign opened without the register', () => {
        // Unlike the BIA register, this one IS a real list resource, so the
        // fallback read is left enabled on purpose: a deep link still steps.
        const Wrapper = makeSharedCache();
        listAnswer = { rows: BEYOND_CAP, truncated: false };

        render(
            <Wrapper>
                <AccessReviewDetailClient
                    tenantSlug="acme"
                    initialReview={detail('rev_3', 'Q3 access review')}
                    currentUserId="usr_reviewer"
                    isAdmin
                />
            </Wrapper>,
        );

        expect(screen.getByTestId('entity-prev-next-nav')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('entity-nav-next'));
        expect(mockReplace).toHaveBeenCalledWith('/t/acme/access-reviews/rev_4');
    });
});
