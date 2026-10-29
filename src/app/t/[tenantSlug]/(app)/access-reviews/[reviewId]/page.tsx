/**
 * Epic G-4 — Access Review detail (server shell).
 *
 * Resolves the campaign + decisions + last-activity map server-side
 * and hands them off to the client for the reviewer-facing UI.
 *
 * #4464 — the page asks `access_reviews.view` before it reads anything, the
 * key `GET /access-reviews/:id` takes. `getAccessReviewWithActivity` asserts
 * only the coarse read tier, so a custom role without the key was refused by
 * the API and still shown the campaign the server rendered here. Every
 * built-in role holds it.
 */
import { notFound } from 'next/navigation';
import { getTenantCtx } from '@/app-layer/context';
import { getAccessReviewWithActivity } from '@/app-layer/usecases/access-review';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { AccessReviewDetailClient } from './AccessReviewDetailClient';

export const dynamic = 'force-dynamic';

export default async function AccessReviewDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; reviewId: string }>;
}) {
    const { tenantSlug, reviewId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    if (!ctx.appPermissions.access_reviews.view) {
        return <ForbiddenPage />;
    }
    let review;
    try {
        review = await getAccessReviewWithActivity(ctx, reviewId);
    } catch {
        notFound();
    }
    return (
        <AccessReviewDetailClient
            tenantSlug={tenantSlug}
            initialReview={review}
            currentUserId={ctx.userId}
            isAdmin={ctx.permissions.canAdmin}
            // #4130 — each affordance follows BOTH gates its server path
            // takes: the route's key and the usecase's `assertCanAdmin`.
            canManage={ctx.permissions.canAdmin && ctx.appPermissions.access_reviews.create}
            canRegenerateEvidence={ctx.permissions.canAdmin && ctx.appPermissions.access_reviews.close}
        />
    );
}
