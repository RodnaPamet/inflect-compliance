/**
 * The Access reviews pages ask `access_reviews.view`, as their API does (#4464).
 *
 * The list page called `listAccessReviews` and the detail page
 * `getAccessReviewWithActivity` straight from the server component. Both
 * usecases assert only the coarse read tier, while `GET /access-reviews` and
 * `GET /access-reviews/:id` take `access_reviews.view`. So a custom role with
 * the key off was refused by the API and still shown, by the server render,
 * every campaign the API would not give it — and the list's client kept those
 * rows as its fallback when its own refetch was refused.
 *
 * Each page now asks the key before it reads anything, and shows the shared
 * Forbidden page to a caller without it. Every built-in role holds the key, so
 * none of them sees a change.
 */
import * as React from 'react';
import type { RequestContext } from '@/app-layer/types';

const getTenantCtxMock = jest.fn();
const listAccessReviewsMock = jest.fn();
const getAccessReviewWithActivityMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));
jest.mock('@/app-layer/usecases/access-review', () => ({
    listAccessReviews: (...a: unknown[]) => listAccessReviewsMock(...a),
    getAccessReviewWithActivity: (...a: unknown[]) => getAccessReviewWithActivityMock(...a),
}));
jest.mock('next/navigation', () => ({
    notFound: () => {
        throw new Error('NEXT_NOT_FOUND');
    },
}));
jest.mock('@/components/ForbiddenPage', () => ({
    ForbiddenPage: function ForbiddenPage() {
        return null;
    },
}));
jest.mock('@/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient', () => ({
    AccessReviewsClient: function AccessReviewsClient() {
        return null;
    },
}));
jest.mock('@/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient', () => ({
    AccessReviewDetailClient: function AccessReviewDetailClient() {
        return null;
    },
}));

import AccessReviewsPage from '@/app/t/[tenantSlug]/(app)/access-reviews/page';
import AccessReviewDetailPage from '@/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/page';
import { makeRequestContext } from '../helpers/make-context';

type Rendered = React.ReactElement<Record<string, unknown>>;

const BUILT_IN_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN'] as const;

const REVIEWS = [{ id: 'rev_1', name: 'Q3 review' }];
const REVIEW = { id: 'rev_1', name: 'Q3 review', decisions: [], lastActivityByUser: {} };

/** A custom role on a READER base with the view key switched off. */
function customRoleWithoutView(): RequestContext {
    const ctx = makeRequestContext('READER');
    ctx.appPermissions = {
        ...ctx.appPermissions,
        access_reviews: { ...ctx.appPermissions.access_reviews, view: false },
    };
    return ctx;
}

function componentName(el: Rendered): string {
    const type = el.type as { name?: string };
    return type.name ?? '';
}

async function renderList(): Promise<Rendered> {
    return (await AccessReviewsPage({ params: Promise.resolve({ tenantSlug: 'acme' }) })) as Rendered;
}

async function renderDetail(): Promise<Rendered> {
    return (await AccessReviewDetailPage({
        params: Promise.resolve({ tenantSlug: 'acme', reviewId: 'rev_1' }),
    })) as Rendered;
}

beforeEach(() => {
    jest.clearAllMocks();
    listAccessReviewsMock.mockResolvedValue(REVIEWS);
    getAccessReviewWithActivityMock.mockResolvedValue(REVIEW);
});

describe('a custom role without access_reviews.view', () => {
    it('is shown the Forbidden page on the list, and nothing is read', async () => {
        getTenantCtxMock.mockResolvedValue(customRoleWithoutView());
        const el = await renderList();
        expect(componentName(el)).toBe('ForbiddenPage');
        expect(listAccessReviewsMock).not.toHaveBeenCalled();
    });

    it('is shown the Forbidden page on a campaign, and nothing is read', async () => {
        getTenantCtxMock.mockResolvedValue(customRoleWithoutView());
        const el = await renderDetail();
        expect(componentName(el)).toBe('ForbiddenPage');
        expect(getAccessReviewWithActivityMock).not.toHaveBeenCalled();
    });
});

describe.each(BUILT_IN_ROLES)('the built-in role %s', (role) => {
    it('holds the key the API takes', () => {
        expect(makeRequestContext(role).appPermissions.access_reviews.view).toBe(true);
    });

    it('still opens the list, with the campaigns the server read', async () => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext(role));
        const el = await renderList();
        expect(componentName(el)).toBe('AccessReviewsClient');
        expect(el.props.initialReviews).toEqual(REVIEWS);
    });

    it('still opens a campaign', async () => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext(role));
        const el = await renderDetail();
        expect(componentName(el)).toBe('AccessReviewDetailClient');
        expect(el.props.initialReview).toEqual(REVIEW);
    });
});
