/**
 * Epic G-4 — Access Reviews list page.
 *
 * Server Component shell — fetches the SSR-capped first page of
 * campaigns and hands them off to the client island for interactive
 * filtering / progress rendering / create-flow.
 */
import { getTenantCtx } from '@/app-layer/context';
import { listAccessReviews } from '@/app-layer/usecases/access-review';
import { AccessReviewsClient } from './AccessReviewsClient';

export const dynamic = 'force-dynamic';

const SSR_PAGE_LIMIT = 100;

export default async function AccessReviewsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    const initialReviews = await listAccessReviews(ctx, {
        take: SSR_PAGE_LIMIT,
    });
    return (
        <AccessReviewsClient
            tenantSlug={tenantSlug}
            initialReviews={initialReviews}
            // #4130 — both gates the create path takes: the route's
            // `access_reviews.create` and the usecase's `assertCanAdmin`.
            canCreate={ctx.permissions.canAdmin && ctx.appPermissions.access_reviews.create}
        />
    );
}
